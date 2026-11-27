import type {
  CaseAuthority,
  CaseCommand,
  CaseCommandBody,
  CasePermission,
  ExternalAction,
} from "@occavoy/domain/case-lifecycle";
import type { SupplierAdapter } from "./fake-supplier";
import { hashCommandPayload, type PostgresCaseStore } from "./postgres-case-store";

interface ActionContext {
  tenantId: string;
  caseId: string;
  actionId: string;
  now: Date;
  /** Trusted, current grant supplied by the caller, not customer or agent input. */
  authority: CaseAuthority;
}
type Observation = Extract<CaseCommandBody, { kind: "reconcile_handoff" | "handoff_unknown" }>;
type Reconciliation = Extract<Observation, { kind: "reconcile_handoff" }>;

/** Only the fresh dispatch transaction may submit; a replayed outbox intent is not permission to send. */
export class DeterministicEffectDispatcher {
  constructor(
    private readonly store: PostgresCaseStore,
    private readonly supplier: SupplierAdapter,
  ) {}

  async dispatchApprovedHandoff(
    input: ActionContext & { clientReference: string; requestHash: string },
  ) {
    // Both post-call outcomes must be recordable before we make an irreversible call.
    const state = await this.readCase(input, [
      "handoff.dispatch",
      "supply.record",
      "action.reconcile",
    ]);
    const proposal = state.proposals.at(-1);
    const quote = state.quotes.find(
      (q) => q.id === proposal?.quoteId && q.version === proposal.quoteVersion,
    );
    if (!proposal || !state.approval) throw new Error("approval_required");
    if (!quote || !(Date.parse(quote.validUntil) > input.now.getTime()))
      throw new Error("quote_expired_or_missing");
    const caps = this.supplier.capabilities;
    if (
      proposal.scope.supplierId !== caps.supplierId ||
      !caps.currencies.includes(proposal.total.currency) ||
      !caps.destinations.includes(state.brief.destination.countryCode)
    ) {
      throw new Error("supplier_scope_mismatch");
    }

    // Under the case lock, the reducer checks this revision, exact approval terms,
    // expiry, cancellation and the absence of any previous action, then emits intent.
    const intent = await this.submit(input, state.revision, {
      kind: "dispatch_handoff",
      actionId: input.actionId,
      clientReference: input.clientReference,
      requestHash: input.requestHash,
    });
    if (intent.decision.outcome !== "applied") throw new Error(intent.decision.reason);
    if (intent.deduplicated) throw new Error("dispatch_already_received");
    const action = intent.decision.state.action!;
    let observation: Observation;
    try {
      const { providerReference } = await this.supplier.submitHandoff({
        actionId: action.id,
        clientReference: action.clientReference,
        requestHash: action.requestHash,
        proposalId: action.proposalId,
        proposalVersion: action.proposalVersion,
        total: proposal.total,
        validUntil: proposal.validUntil,
      });
      if (!providerReference?.trim()) throw new Error("missing_supplier_confirmation");
      observation = {
        kind: "reconcile_handoff",
        actionId: action.id,
        result: "confirmed",
        source: "provider_lookup",
        providerReference,
        evidenceRef: `supplier-confirmation:${providerReference}`,
      };
    } catch {
      // Transport failure proves neither acceptance nor nonexecution. Do not log the provider error.
      observation = {
        kind: "handoff_unknown",
        actionId: action.id,
        evidenceRef: `supplier-response-unavailable:${action.clientReference}`,
      };
    }
    const observed = await this.record(input, action, observation);
    for (const id of intent.outboxIds) await this.store.completeOutbox(id);
    return observed;
  }

  async reconcileUnknownAction(input: ActionContext) {
    const action = await this.readAction(input);
    if (!this.supplier.capabilities.supportsLookup)
      return { needsOperatorReconciliation: true } as const;
    const lookup = await this.supplier.lookupByClientReference(action.clientReference);
    // A dispatcher could still be in flight. A negative lookup at that point
    // is not proof that its submission won't arrive a moment later.
    if (!lookup.found && action.status === "dispatching")
      throw new Error("dispatch_still_in_flight");
    return this.record(input, action, {
      kind: "reconcile_handoff",
      actionId: action.id,
      result: lookup.found ? "confirmed" : "not_executed",
      source: "provider_lookup",
      providerReference: lookup.found ? lookup.providerReference : null,
      evidenceRef: `supplier-lookup:${action.clientReference}`,
    });
  }

  async recordOperatorReconciliation(
    input: ActionContext & Pick<Reconciliation, "result" | "providerReference" | "evidenceRef">,
  ) {
    const action = await this.readAction(input);
    if (action.status !== "unknown") throw new Error("operator_reconciliation_requires_unknown");
    return this.record(input, action, {
      kind: "reconcile_handoff",
      source: "operator_verified",
      actionId: input.actionId,
      result: input.result,
      providerReference: input.providerReference,
      evidenceRef: input.evidenceRef,
    });
  }

  private async readCase(input: ActionContext, permissions: CasePermission[]) {
    const { tenantId, caseId, now, authority } = input;
    if (
      tenantId !== this.supplier.tenantId ||
      tenantId !== authority.tenantId ||
      caseId !== authority.caseId ||
      !authority.actorId.trim() ||
      !authority.grantId.trim() ||
      !(Date.parse(authority.validUntil) > now.getTime()) ||
      !permissions.every((permission) => authority.permissions.includes(permission))
    ) {
      throw new Error("authority_or_scope_mismatch");
    }
    const state = await this.store.getCase(tenantId, caseId);
    if (!state) throw new Error("case_not_found");
    return state;
  }

  private async readAction(input: ActionContext) {
    const state = await this.readCase(input, ["action.reconcile"]);
    const action = state.action;
    if (
      !action ||
      action.id !== input.actionId ||
      (action.status !== "unknown" && action.status !== "dispatching")
    )
      throw new Error("action_not_reconcilable");
    const proposal = state.proposals.find(
      (p) => p.id === action.proposalId && p.version === action.proposalVersion,
    );
    if (proposal?.scope.supplierId !== this.supplier.capabilities.supplierId)
      throw new Error("supplier_scope_mismatch");
    return action;
  }

  private submit(input: ActionContext, revision: number, body: CaseCommandBody) {
    const command: CaseCommand = {
      ...body,
      tenantId: input.tenantId,
      caseId: input.caseId,
      commandId: "",
      expectedRevision: revision,
    };
    command.commandId = `effect:${hashCommandPayload(command)}`;
    return this.store.submitCommand(command, { now: input.now, authority: input.authority });
  }

  private async record(input: ActionContext, attempt: ExternalAction, observation: Observation) {
    // Payment/cancellation can change the revision during I/O. Retry only the
    // observation CAS, never provider I/O or an observation for a newer attempt.
    for (let i = 0; i < 3; i++) {
      const state = await this.store.getCase(input.tenantId, input.caseId);
      if (state?.action?.id !== attempt.id || state.action.attempts !== attempt.attempts)
        throw new Error("action_attempt_changed");
      const result = await this.submit(input, state.revision, observation);
      if (result.decision.outcome === "applied") return result.decision.state;
      if (result.decision.reason !== "stale_case_revision") throw new Error(result.decision.reason);
    }
    throw new Error("stale_case_revision");
  }
}
