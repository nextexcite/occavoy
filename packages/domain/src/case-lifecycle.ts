import { demoEvents, type EventRecord, type ServiceBrief } from "./index";

/**
 * Executable domain contract, not a database, authentication service or workflow engine.
 * The caller must authenticate, validate untrusted input and commit the returned decision
 * with its command/result/outbox in one transaction. This reducer never performs I/O.
 * Rivet may checkpoint a Case execution and a bounded AgentTask independently; neither
 * checkpoint is a second authority for these commercial records.
 */
type Money = ServiceBrief["budget"];
export type CasePhase =
  | "draft"
  | "clarifying"
  | "sourcing"
  | "proposal_ready"
  | "awaiting_approval"
  | "fulfilling"
  | "closed";
export type CaseWaitReason =
  | "agent_task"
  | "supplier_quote"
  | "approval"
  | "supplier_confirmation"
  | "reconciliation"
  | null;

export interface CustomerRelationship {
  id: string;
  tenantId: string;
  customerId: string;
  preferenceReuseAllowed: boolean;
}

export interface CaseScope {
  tenantId: string;
  caseId: string;
  relationshipId: string;
  customerId: string;
}

export interface CaseBrief {
  id: string;
  version: number;
  eventId: string;
  destination: EventRecord["destination"];
  budget: Money;
  approverActorId: string;
}

/** One finite job may contain multiple model turns. It is not the relationship or case. */
export interface AgentTaskReference {
  taskId: string;
  tenantId: string;
  caseId: string;
  briefVersion: number;
  caseRevision: number;
  maxModelCalls: number;
  maxToolCalls: number;
  deadline: string;
}

export interface ResourceRequirement {
  id: string;
  category: "event_access" | "accommodation" | "transport";
  description: string;
}

/** Suggestions only: a model cannot approve, book, mark paid or close a case. */
export interface AgentTaskCandidate {
  task: AgentTaskReference;
  requirements: ResourceRequirement[];
}

export interface CaseRfq {
  id: string;
  supplierId: string;
  briefVersion: number;
  requirementIds: string[];
}

/** The first executable slice has one supplier component, not a package sale. */
export interface CaseQuote {
  id: string;
  version: number;
  tenantId: string;
  caseId: string;
  rfqId: string;
  briefVersion: number;
  supplierId: string;
  sellerId: string;
  fulfillerId: string;
  payeeId: string;
  total: Money;
  validUntil: string;
  availability: "observed" | "quoted" | "held";
  evidenceRef: string;
}

export interface HandoffScope {
  kind: "supplier_handoff";
  supplierId: string;
  lineIds: string[];
}

export interface CaseProposal {
  id: string;
  version: number;
  tenantId: string;
  caseId: string;
  briefVersion: number;
  quoteId: string;
  quoteVersion: number;
  /** A trusted boundary computes the canonical terms hash before committing this version. */
  termsHash: string;
  total: Money;
  validUntil: string;
  approverActorId: string;
  scope: HandoffScope;
}

export interface ProposalApproval {
  id: string;
  tenantId: string;
  caseId: string;
  proposalId: string;
  proposalVersion: number;
  termsHash: string;
  total: Money;
  validUntil: string;
  scope: HandoffScope;
  approvedBy: string;
  authorityGrantId: string;
  approvedAt: string;
}

export type CasePermission =
  | "case.edit"
  | "agent.result"
  | "supply.request"
  | "supply.record"
  | "proposal.write"
  | "proposal.approve"
  | "handoff.dispatch"
  | "action.reconcile"
  | "fulfillment.record"
  | "case.close";

/** Derived by a trusted server, never copied from a request body or model response. */
export interface CaseAuthority {
  tenantId: string;
  caseId: string;
  actorId: string;
  grantId: string;
  permissions: CasePermission[];
  validUntil: string;
}

export interface HandoffAttemptFence {
  /** Supplier-generated freshness challenge for one successful fence; never parsed for meaning. */
  fenceId: string;
  clientReference: string;
  attempt: number;
  evidenceRef: string;
}

export interface RecordedHandoffAttemptFence extends HandoffAttemptFence {
  recordedBy: string;
  recordedAt: string;
}

/** Binds a terminal nonexecution observation to one fenced sender attempt. */
export interface HandoffNonexecutionProof {
  fenceId: string;
  attempt: number;
}

export interface ExternalAction {
  id: string;
  clientReference: string;
  requestHash: string;
  proposalId: string;
  proposalVersion: number;
  status: "dispatching" | "unknown" | "confirmed" | "not_executed";
  attempts: number;
  providerReference: string | null;
  evidenceRefs: string[];
  attemptFences: RecordedHandoffAttemptFence[];
  reconciliationEvidence: Array<{
    source: "provider_lookup" | "operator_verified";
    result: "confirmed" | "not_executed" | "unresolved";
    evidenceRef: string;
    recordedBy: string;
    recordedAt: string;
    attempt?: number;
    fenceId?: string;
  }>;
}

export interface CaseSnapshot {
  scope: CaseScope;
  revision: number;
  phase: CasePhase;
  waitReason: CaseWaitReason;
  deadline: string;
  sourceEvent: EventRecord;
  brief: CaseBrief;
  activeTask: AgentTaskReference | null;
  requirements: ResourceRequirement[];
  rfq: CaseRfq | null;
  quotes: CaseQuote[];
  proposals: CaseProposal[];
  approval: ProposalApproval | null;
  action: ExternalAction | null;
  booking: "not_submitted" | "pending" | "confirmed" | "not_booked";
  payment: "unobserved" | "paid";
  fulfillment: "pending" | "completed";
  paymentEvidence: string | null;
  fulfillmentEvidence: string | null;
  cancelRequested: boolean;
  cancellationReason: string | null;
  outcome: "fulfilled" | "declined" | "unavailable" | "cancelled" | null;
}

export type CaseCommandBody =
  | { kind: "activate"; taskId: string; maxModelCalls: number; maxToolCalls: number }
  | { kind: "cancel"; reason: string }
  | { kind: "revise_brief"; brief: CaseBrief }
  | { kind: "agent_candidate"; candidate: AgentTaskCandidate }
  | { kind: "request_quote"; rfq: CaseRfq }
  | { kind: "record_quote"; quote: CaseQuote }
  | { kind: "stage_proposal"; proposal: CaseProposal }
  | { kind: "publish_proposal" }
  | { kind: "approve_proposal"; approval: ProposalApproval }
  | { kind: "dispatch_handoff"; actionId: string; clientReference: string; requestHash: string }
  | { kind: "retry_handoff"; actionId: string }
  | { kind: "handoff_unknown"; actionId: string; evidenceRef: string }
  | { kind: "fence_handoff_attempt"; actionId: string; fence: HandoffAttemptFence }
  | {
      kind: "reconcile_handoff";
      actionId: string;
      result: "confirmed" | "not_executed" | "unresolved";
      source: "provider_lookup" | "operator_verified";
      evidenceRef: string;
      providerReference: string | null;
      nonexecutionProof?: HandoffNonexecutionProof;
    }
  | { kind: "record_payment"; total: Money; evidenceRef: string }
  | { kind: "record_fulfillment"; evidenceRef: string }
  | { kind: "close"; outcome: "fulfilled" | "declined" | "unavailable" };

export type CaseCommand = CaseCommandBody & {
  commandId: string;
  tenantId: string;
  caseId: string;
  expectedRevision: number;
};

export type CaseIntent =
  | { kind: "run_agent_task"; task: AgentTaskReference }
  | { kind: "cancel_agent_task"; task: AgentTaskReference }
  | { kind: "request_supplier_quote"; rfq: CaseRfq }
  | { kind: "supplier_handoff"; action: ExternalAction; approval: ProposalApproval };

export interface CaseDecision {
  outcome: "applied" | "ignored" | "rejected";
  reason: string;
  state: CaseSnapshot;
  intents: CaseIntent[];
}

const permissions: Record<CaseCommandBody["kind"], CasePermission> = {
  activate: "case.edit",
  cancel: "case.edit",
  revise_brief: "case.edit",
  agent_candidate: "agent.result",
  request_quote: "supply.request",
  record_quote: "supply.record",
  stage_proposal: "proposal.write",
  publish_proposal: "proposal.write",
  approve_proposal: "proposal.approve",
  dispatch_handoff: "handoff.dispatch",
  retry_handoff: "handoff.dispatch",
  handoff_unknown: "supply.record",
  fence_handoff_attempt: "action.reconcile",
  reconcile_handoff: "action.reconcile",
  record_payment: "fulfillment.record",
  record_fulfillment: "fulfillment.record",
  close: "case.close",
};

function validMoney(value: Money): boolean {
  return (
    Number.isSafeInteger(value.amountMinor) &&
    value.amountMinor >= 0 &&
    /^[A-Z]{3}$/.test(value.currency)
  );
}

function sameMoney(left: Money, right: Money): boolean {
  return left.amountMinor === right.amountMinor && left.currency === right.currency;
}

function quoteContent(quote: CaseQuote): string {
  // Compare semantic fields, independent of an incoming object's property order.
  return JSON.stringify([
    quote.id,
    quote.version,
    quote.tenantId,
    quote.caseId,
    quote.rfqId,
    quote.briefVersion,
    quote.supplierId,
    quote.sellerId,
    quote.fulfillerId,
    quote.payeeId,
    quote.total.amountMinor,
    quote.total.currency,
    quote.validUntil,
    quote.availability,
    quote.evidenceRef,
  ]);
}

function sameScope(left: HandoffScope, right: HandoffScope): boolean {
  return (
    left.kind === right.kind &&
    left.supplierId === right.supplierId &&
    left.lineIds.length === right.lineIds.length &&
    left.lineIds.every((id, index) => id === right.lineIds[index])
  );
}

function beforeExpiry(expiry: string, now: Date): boolean {
  return Number.isFinite(now.getTime()) && Date.parse(expiry) > now.getTime();
}

/**
 * Exact proposal binding, including purchase scope. This is still a pure preflight:
 * a trusted caller must resolve current grant validity/revocation and immutable terms
 * at dispatch, and enforce the resulting decision with transactional CAS.
 */
export function checkProposalApproval(
  proposal: CaseProposal,
  approval: ProposalApproval,
  now: Date,
): { ok: true } | { ok: false; reason: string } {
  if (
    proposal.tenantId !== approval.tenantId ||
    proposal.caseId !== approval.caseId ||
    proposal.id !== approval.proposalId ||
    proposal.version !== approval.proposalVersion ||
    proposal.termsHash !== approval.termsHash ||
    !sameMoney(proposal.total, approval.total) ||
    !sameScope(proposal.scope, approval.scope) ||
    proposal.validUntil !== approval.validUntil
  ) {
    return { ok: false, reason: "approval_terms_mismatch" };
  }
  if (
    approval.approvedBy !== proposal.approverActorId ||
    !approval.authorityGrantId.trim() ||
    !approval.id.trim()
  ) {
    return { ok: false, reason: "approval_authority_mismatch" };
  }
  const approved = Date.parse(approval.approvedAt);
  if (
    !validMoney(proposal.total) ||
    !Number.isFinite(approved) ||
    approved > now.getTime() ||
    !beforeExpiry(proposal.validUntil, now)
  ) {
    return { ok: false, reason: "approval_expired_or_invalid" };
  }
  return { ok: true };
}

export function createServiceCase(input: {
  relationship: CustomerRelationship;
  caseId: string;
  sourceEvent: EventRecord;
  brief: CaseBrief;
  deadline: string;
}): CaseSnapshot {
  if (
    !input.caseId.trim() ||
    input.brief.version !== 1 ||
    input.brief.eventId !== input.sourceEvent.id ||
    !validMoney(input.brief.budget) ||
    !Number.isFinite(Date.parse(input.deadline))
  ) {
    throw new Error("Invalid initial case contract");
  }
  return structuredClone({
    scope: {
      tenantId: input.relationship.tenantId,
      caseId: input.caseId,
      relationshipId: input.relationship.id,
      customerId: input.relationship.customerId,
    },
    revision: 0,
    phase: "draft",
    waitReason: null,
    deadline: input.deadline,
    sourceEvent: input.sourceEvent,
    brief: input.brief,
    activeTask: null,
    requirements: [],
    rfq: null,
    quotes: [],
    proposals: [],
    approval: null,
    action: null,
    booking: "not_submitted",
    payment: "unobserved",
    fulfillment: "pending",
    paymentEvidence: null,
    fulfillmentEvidence: null,
    cancelRequested: false,
    cancellationReason: null,
    outcome: null,
  });
}

/**
 * A deterministic transition only. expectedRevision is a preflight, not a substitute
 * for Postgres CAS. Command-ID deduplication and payload conflict checks belong to the
 * transactional command ledger. A returned intent is not evidence of an external call.
 */
export function decideCase(
  current: CaseSnapshot,
  command: CaseCommand,
  context: { now: Date; authority: CaseAuthority },
): CaseDecision {
  const stop = (reason: string, outcome: "ignored" | "rejected" = "rejected"): CaseDecision => ({
    outcome,
    reason,
    state: current,
    intents: [],
  });
  const { authority, now } = context;
  if (
    command.tenantId !== current.scope.tenantId ||
    command.caseId !== current.scope.caseId ||
    authority.tenantId !== current.scope.tenantId ||
    authority.caseId !== current.scope.caseId ||
    !authority.actorId.trim() ||
    !authority.grantId.trim() ||
    !authority.permissions.includes(permissions[command.kind]) ||
    !beforeExpiry(authority.validUntil, now)
  ) {
    return stop("authority_or_scope_mismatch");
  }
  if (command.expectedRevision !== current.revision) {
    return stop("stale_case_revision", command.kind === "agent_candidate" ? "ignored" : "rejected");
  }
  if (current.phase === "closed") {
    return stop("case_closed", command.kind === "agent_candidate" ? "ignored" : "rejected");
  }
  // Existing obligations still accept observations. Cancellation fences new work,
  // not facts about something a supplier may already have done.
  if (
    current.cancelRequested &&
    [
      "activate",
      "revise_brief",
      "agent_candidate",
      "request_quote",
      "stage_proposal",
      "publish_proposal",
      "approve_proposal",
      "dispatch_handoff",
      "retry_handoff",
    ].includes(command.kind)
  ) {
    return stop("cancellation_requested");
  }
  const next = structuredClone(current);
  const intents: CaseIntent[] = [];
  const proposal = current.proposals.at(-1);
  switch (command.kind) {
    case "cancel": {
      if (!command.reason.trim()) return stop("cancellation_reason_required");
      if (current.cancelRequested) return stop("cancellation_already_requested", "ignored");
      next.cancelRequested = true;
      next.cancellationReason = command.reason;
      if (current.activeTask) {
        intents.push({ kind: "cancel_agent_task", task: structuredClone(current.activeTask) });
      }
      next.activeTask = null;
      if (current.action) {
        // No claim that an external booking has been undone. Supplier change/refund
        // resolution is deliberately outside this small executable contract.
        next.waitReason = "reconciliation";
      } else {
        next.approval = null;
        next.phase = "closed";
        next.waitReason = null;
        next.outcome = "cancelled";
      }
      break;
    }
    case "activate": {
      if (current.phase !== "draft" && current.phase !== "clarifying") return stop("wrong_phase");
      if (current.activeTask) return stop("task_already_active");
      if (
        !command.taskId.trim() ||
        !Number.isInteger(command.maxModelCalls) ||
        command.maxModelCalls < 1 ||
        !Number.isInteger(command.maxToolCalls) ||
        command.maxToolCalls < 0 ||
        !beforeExpiry(current.deadline, now)
      ) {
        return stop("invalid_task_allowance");
      }
      next.phase = "clarifying";
      next.waitReason = "agent_task";
      next.activeTask = {
        taskId: command.taskId,
        tenantId: current.scope.tenantId,
        caseId: current.scope.caseId,
        briefVersion: current.brief.version,
        caseRevision: current.revision + 1,
        maxModelCalls: command.maxModelCalls,
        maxToolCalls: command.maxToolCalls,
        deadline: current.deadline,
      };
      intents.push({ kind: "run_agent_task", task: structuredClone(next.activeTask) });
      break;
    }
    case "revise_brief": {
      if (current.action) return stop("external_obligation_exists");
      if (
        command.brief.id !== current.brief.id ||
        command.brief.version !== current.brief.version + 1 ||
        command.brief.eventId !== current.sourceEvent.id ||
        !validMoney(command.brief.budget)
      ) {
        return stop("invalid_brief_revision");
      }
      next.brief = structuredClone(command.brief);
      next.activeTask = null;
      next.requirements = [];
      next.rfq = null;
      next.approval = null;
      next.phase = "clarifying";
      next.waitReason = null;
      break;
    }
    case "agent_candidate": {
      const task = command.candidate.task;
      if (
        !current.activeTask ||
        task.taskId !== current.activeTask.taskId ||
        task.tenantId !== current.scope.tenantId ||
        task.caseId !== current.scope.caseId ||
        task.briefVersion !== current.brief.version ||
        task.caseRevision !== current.revision ||
        !beforeExpiry(current.activeTask.deadline, now)
      ) {
        return stop("stale_agent_candidate", "ignored");
      }
      if (
        command.candidate.requirements.length === 0 ||
        new Set(command.candidate.requirements.map((r) => r.id)).size !==
          command.candidate.requirements.length
      ) {
        return stop("invalid_requirements");
      }
      next.requirements = structuredClone(command.candidate.requirements);
      next.activeTask = null;
      next.phase = "sourcing";
      next.waitReason = null;
      break;
    }
    case "request_quote": {
      if (current.phase !== "sourcing" || current.rfq) return stop("wrong_phase");
      if (
        command.rfq.briefVersion !== current.brief.version ||
        !command.rfq.id.trim() ||
        !command.rfq.supplierId.trim() ||
        command.rfq.requirementIds.length === 0 ||
        !command.rfq.requirementIds.every((id) => current.requirements.some((r) => r.id === id))
      ) {
        return stop("rfq_requirement_mismatch");
      }
      next.rfq = structuredClone(command.rfq);
      next.waitReason = "supplier_quote";
      intents.push({ kind: "request_supplier_quote", rfq: structuredClone(command.rfq) });
      break;
    }
    case "record_quote": {
      const quote = command.quote;
      if (current.action) return stop("quote_after_handoff", "ignored");
      if (
        quote.tenantId !== current.scope.tenantId ||
        quote.caseId !== current.scope.caseId ||
        quote.rfqId !== current.rfq?.id ||
        quote.supplierId !== current.rfq.supplierId ||
        quote.briefVersion !== current.brief.version
      ) {
        return stop("stale_or_unscoped_quote", "ignored");
      }
      const previous = current.quotes.find((q) => q.id === quote.id && q.version === quote.version);
      if (previous) {
        return quoteContent(previous) === quoteContent(quote)
          ? stop("duplicate_quote", "ignored")
          : stop("immutable_quote_conflict");
      }
      if (
        !validMoney(quote.total) ||
        !Number.isInteger(quote.version) ||
        quote.version < 1 ||
        !quote.sellerId.trim() ||
        !quote.fulfillerId.trim() ||
        !quote.payeeId.trim() ||
        !quote.evidenceRef.trim() ||
        !beforeExpiry(quote.validUntil, now)
      ) {
        return stop("incomplete_or_expired_quote");
      }
      next.quotes.push(structuredClone(quote));
      if (next.waitReason === "supplier_quote") next.waitReason = null;
      break;
    }
    case "stage_proposal": {
      const offered = command.proposal;
      const quote = current.quotes.find(
        (q) => q.id === offered.quoteId && q.version === offered.quoteVersion,
      );
      if (current.action) return stop("external_obligation_exists");
      if (
        !quote ||
        quote.availability === "observed" ||
        !beforeExpiry(quote.validUntil, now) ||
        offered.tenantId !== current.scope.tenantId ||
        offered.caseId !== current.scope.caseId ||
        offered.briefVersion !== current.brief.version ||
        quote.briefVersion !== current.brief.version ||
        offered.version !== (proposal?.version ?? 0) + 1 ||
        (proposal && offered.id !== proposal.id) ||
        !offered.termsHash.trim() ||
        !sameMoney(offered.total, quote.total) ||
        offered.validUntil !== quote.validUntil ||
        offered.approverActorId !== current.brief.approverActorId ||
        offered.scope.kind !== "supplier_handoff" ||
        offered.scope.supplierId !== quote.supplierId ||
        offered.scope.lineIds.length !== 1 ||
        offered.scope.lineIds[0] !== quote.id
      ) {
        return stop("proposal_quote_or_scope_mismatch");
      }
      next.proposals.push(structuredClone(offered));
      next.approval = null;
      next.phase = "proposal_ready";
      next.waitReason = null;
      break;
    }
    case "publish_proposal":
      if (current.phase !== "proposal_ready" || !proposal) return stop("wrong_phase");
      if (!beforeExpiry(proposal.validUntil, now)) return stop("proposal_expired");
      next.phase = "awaiting_approval";
      next.waitReason = "approval";
      break;
    case "approve_proposal": {
      if (current.phase !== "awaiting_approval" || !proposal) return stop("wrong_phase");
      if (
        command.approval.approvedBy !== authority.actorId ||
        command.approval.authorityGrantId !== authority.grantId
      ) {
        return stop("approval_authority_mismatch");
      }
      const check = checkProposalApproval(proposal, command.approval, now);
      if (!check.ok) return stop(check.reason);
      next.approval = structuredClone(command.approval);
      next.phase = "fulfilling";
      next.waitReason = null;
      break;
    }
    case "dispatch_handoff":
    case "retry_handoff": {
      if (current.action?.status === "unknown" || current.action?.status === "dispatching") {
        return stop("reconciliation_required");
      }
      if (current.phase !== "fulfilling" || !proposal || !current.approval) {
        return stop("approval_required");
      }
      const check = checkProposalApproval(proposal, current.approval, now);
      if (!check.ok) return stop(check.reason);
      if (command.kind === "retry_handoff") {
        if (current.action?.id !== command.actionId || current.action.status !== "not_executed") {
          return stop("proof_of_nonexecution_required");
        }
        next.action = {
          ...current.action,
          status: "dispatching",
          attempts: current.action.attempts + 1,
        };
      } else {
        if (current.action) return stop("action_already_exists");
        if (
          !command.actionId.trim() ||
          !command.clientReference.trim() ||
          !command.requestHash.trim()
        ) {
          return stop("invalid_action_identity");
        }
        next.action = {
          id: command.actionId,
          clientReference: command.clientReference,
          requestHash: command.requestHash,
          proposalId: proposal.id,
          proposalVersion: proposal.version,
          status: "dispatching",
          attempts: 1,
          providerReference: null,
          evidenceRefs: [],
          attemptFences: [],
          reconciliationEvidence: [],
        };
      }
      next.booking = "pending";
      next.waitReason = "supplier_confirmation";
      intents.push({
        kind: "supplier_handoff",
        action: structuredClone(next.action),
        approval: structuredClone(current.approval),
      });
      break;
    }
    case "handoff_unknown":
      if (current.action?.id !== command.actionId || current.action.status !== "dispatching") {
        return stop("action_not_dispatching");
      }
      if (!command.evidenceRef.trim()) return stop("evidence_required");
      next.action = {
        ...current.action,
        status: "unknown",
        evidenceRefs: [...current.action.evidenceRefs, command.evidenceRef],
      };
      next.waitReason = "reconciliation";
      break;
    case "fence_handoff_attempt": {
      if (
        current.action?.id !== command.actionId ||
        !["unknown", "dispatching"].includes(current.action.status)
      ) {
        return stop("action_not_reconcilable");
      }
      const fence = command.fence;
      const fences = current.action.attemptFences ?? [];
      if (
        !fence.fenceId.trim() ||
        !fence.evidenceRef.trim() ||
        fence.clientReference !== current.action.clientReference ||
        fence.attempt !== current.action.attempts ||
        !Number.isInteger(fence.attempt) ||
        fence.attempt < 1
      ) {
        return stop("invalid_attempt_fence");
      }
      if (fences.some((recorded) => recorded.fenceId === fence.fenceId)) {
        return stop("duplicate_attempt_fence");
      }
      next.action = {
        ...current.action,
        status: "unknown",
        evidenceRefs: [...current.action.evidenceRefs, fence.evidenceRef],
        attemptFences: [
          ...fences,
          {
            ...structuredClone(fence),
            recordedBy: authority.actorId,
            recordedAt: now.toISOString(),
          },
        ],
      };
      next.waitReason = "reconciliation";
      break;
    }
    case "reconcile_handoff":
      if (
        current.action?.id !== command.actionId ||
        !["unknown", "dispatching"].includes(current.action.status)
      ) {
        return stop("action_not_reconcilable");
      }
      if (current.action.status === "dispatching" && command.result !== "confirmed") {
        return stop("dispatch_still_in_flight");
      }
      if (
        !command.evidenceRef.trim() ||
        (command.result === "confirmed" && !command.providerReference?.trim())
      ) {
        return stop("evidence_required");
      }
      if (command.result === "not_executed") {
        const proof = command.nonexecutionProof;
        const fence = (current.action.attemptFences ?? []).find(
          (recorded) => recorded.fenceId === proof?.fenceId,
        );
        if (
          !proof ||
          proof.attempt !== current.action.attempts ||
          !fence ||
          fence.attempt !== current.action.attempts ||
          fence.clientReference !== current.action.clientReference
        ) {
          return stop("terminal_nonexecution_proof_required");
        }
      }
      next.action = {
        ...current.action,
        status: command.result === "unresolved" ? "unknown" : command.result,
        providerReference: command.providerReference,
        evidenceRefs: [...current.action.evidenceRefs, command.evidenceRef],
        reconciliationEvidence: [
          ...current.action.reconciliationEvidence,
          {
            source: command.source,
            result: command.result,
            evidenceRef: command.evidenceRef,
            recordedBy: authority.actorId,
            recordedAt: now.toISOString(),
            ...(command.nonexecutionProof
              ? {
                  attempt: command.nonexecutionProof.attempt,
                  fenceId: command.nonexecutionProof.fenceId,
                }
              : {}),
          },
        ],
      };
      next.waitReason =
        command.result === "unresolved" || current.cancelRequested ? "reconciliation" : null;
      if (command.result === "confirmed") next.booking = "confirmed";
      if (command.result === "not_executed") next.booking = "not_booked";
      break;
    case "record_payment":
      if (!proposal || !current.action || !sameMoney(proposal.total, command.total)) {
        return stop("payment_scope_mismatch");
      }
      if (!command.evidenceRef.trim()) return stop("evidence_required");
      next.payment = "paid";
      next.paymentEvidence = command.evidenceRef;
      break;
    case "record_fulfillment":
      if (current.booking !== "confirmed") return stop("booking_confirmation_required");
      if (!command.evidenceRef.trim()) return stop("evidence_required");
      next.fulfillment = "completed";
      next.fulfillmentEvidence = command.evidenceRef;
      break;
    case "close":
      if (current.cancelRequested && current.action) {
        return stop("supplier_cancellation_resolution_required");
      }
      if (
        current.action?.status === "unknown" ||
        current.action?.status === "dispatching" ||
        (current.action?.status === "confirmed" && current.fulfillment !== "completed")
      ) {
        return stop("external_obligation_unresolved");
      }
      if (command.outcome === "fulfilled" && current.fulfillment !== "completed") {
        return stop("fulfillment_evidence_required");
      }
      next.phase = "closed";
      next.waitReason = null;
      next.activeTask = null;
      next.outcome = command.outcome;
      break;
  }
  next.revision += 1;
  return { outcome: "applied", reason: command.kind, state: next, intents };
}

/** A follow-up starts a fresh finite case. No prior approval or running job is inherited. */
export function createFollowupCase(
  previous: CaseSnapshot,
  input: Parameters<typeof createServiceCase>[0],
): CaseSnapshot {
  if (
    previous.phase !== "closed" ||
    input.caseId === previous.scope.caseId ||
    input.relationship.id !== previous.scope.relationshipId ||
    input.relationship.tenantId !== previous.scope.tenantId ||
    input.relationship.customerId !== previous.scope.customerId
  ) {
    throw new Error("Follow-up requires the same relationship and a new case identity");
  }
  return createServiceCase(input);
}

/** Public synthetic fixture. It proves domain decisions only; all providers are simulated. */
export function runCaseJourneyFixture(event: EventRecord = demoEvents[1]!, currency = "GBP") {
  const relationship: CustomerRelationship = {
    id: "relationship-fixture",
    tenantId: "tenant-fixture",
    customerId: "customer-fixture",
    preferenceReuseAllowed: true,
  };
  const brief: CaseBrief = {
    id: "brief-fixture",
    version: 1,
    eventId: event.id,
    destination: event.destination,
    budget: { amountMinor: 100000, currency },
    approverActorId: "payer-fixture",
  };
  let state = createServiceCase({
    relationship,
    caseId: "case-fixture-1",
    sourceEvent: event,
    brief,
    deadline: "2027-01-10T12:00:00Z",
  });
  const now = new Date("2027-01-01T12:00:00Z");
  const authority: CaseAuthority = {
    tenantId: state.scope.tenantId,
    caseId: state.scope.caseId,
    actorId: "payer-fixture",
    grantId: "fixture-grant",
    permissions: Object.values(permissions),
    validUntil: "2027-01-10T12:00:00Z",
  };
  const trace: Array<{
    command: string;
    outcome: CaseDecision["outcome"];
    reason: string;
    revision: number;
    phase: CasePhase;
    waitReason: CaseWaitReason;
    booking: CaseSnapshot["booking"];
    payment: CaseSnapshot["payment"];
    fulfillment: CaseSnapshot["fulfillment"];
    intents: CaseIntent["kind"][];
  }> = [];
  const apply = (body: CaseCommandBody, expectedOutcome: CaseDecision["outcome"] = "applied") => {
    // Synthetic grants illustrate separate actors. Production derives these server-side.
    let actorId = "runtime-fixture";
    if (body.kind === "approve_proposal") actorId = "payer-fixture";
    if (body.kind === "record_quote") actorId = "supplier-fixture";
    if (body.kind === "reconcile_handoff" && body.source === "operator_verified") {
      actorId = "operator-fixture";
    }
    const commandAuthority: CaseAuthority = {
      ...authority,
      actorId,
      grantId: actorId === "payer-fixture" ? authority.grantId : `fixture-grant-${actorId}`,
      permissions: [permissions[body.kind]],
    };
    const result = decideCase(
      state,
      {
        ...body,
        commandId: `fixture-command-${trace.length + 1}`,
        tenantId: state.scope.tenantId,
        caseId: state.scope.caseId,
        expectedRevision: state.revision,
      },
      { now, authority: commandAuthority },
    );
    if (result.outcome !== expectedOutcome)
      throw new Error(`Fixture failed: ${body.kind}: ${result.reason}`);
    state = result.state;
    trace.push({
      command: body.kind,
      outcome: result.outcome,
      reason: result.reason,
      revision: state.revision,
      phase: state.phase,
      waitReason: state.waitReason,
      booking: state.booking,
      payment: state.payment,
      fulfillment: state.fulfillment,
      intents: result.intents.map((intent) => intent.kind),
    });
  };
  apply({ kind: "activate", taskId: "task-fixture", maxModelCalls: 2, maxToolCalls: 3 });
  if (!state.activeTask) throw new Error("Missing fixture task");
  apply({
    kind: "agent_candidate",
    candidate: {
      task: state.activeTask,
      requirements: [
        { id: "hotel", category: "accommodation", description: "One room near the selected event" },
      ],
    },
  });
  apply({
    kind: "request_quote",
    rfq: {
      id: "rfq-fixture",
      supplierId: "supplier-fixture",
      briefVersion: 1,
      requirementIds: ["hotel"],
    },
  });
  const quote: CaseQuote = {
    id: "quote-fixture",
    version: 1,
    tenantId: state.scope.tenantId,
    caseId: state.scope.caseId,
    rfqId: "rfq-fixture",
    briefVersion: 1,
    supplierId: "supplier-fixture",
    sellerId: "seller-fixture",
    fulfillerId: "hotel-fixture",
    payeeId: "seller-fixture",
    total: { amountMinor: 30000, currency },
    validUntil: "2027-01-02T12:00:00Z",
    availability: "quoted",
    evidenceRef: "synthetic:quote-response",
  };
  apply({ kind: "record_quote", quote });
  const proposal: CaseProposal = {
    id: "proposal-fixture",
    version: 1,
    tenantId: state.scope.tenantId,
    caseId: state.scope.caseId,
    briefVersion: 1,
    quoteId: quote.id,
    quoteVersion: 1,
    termsHash: "synthetic:terms-v1",
    total: quote.total,
    validUntil: quote.validUntil,
    approverActorId: brief.approverActorId,
    scope: { kind: "supplier_handoff", supplierId: quote.supplierId, lineIds: [quote.id] },
  };
  apply({ kind: "stage_proposal", proposal });
  apply({ kind: "publish_proposal" });
  apply({
    kind: "approve_proposal",
    approval: {
      id: "approval-fixture",
      tenantId: state.scope.tenantId,
      caseId: state.scope.caseId,
      proposalId: proposal.id,
      proposalVersion: 1,
      termsHash: proposal.termsHash,
      total: proposal.total,
      validUntil: proposal.validUntil,
      scope: proposal.scope,
      approvedBy: authority.actorId,
      authorityGrantId: authority.grantId,
      approvedAt: now.toISOString(),
    },
  });
  apply({
    kind: "dispatch_handoff",
    actionId: "action-fixture",
    clientReference: "client-fixture",
    requestHash: "synthetic:request-v1",
  });
  apply({
    kind: "handoff_unknown",
    actionId: "action-fixture",
    evidenceRef: "synthetic:lost-response",
  });
  apply({ kind: "retry_handoff", actionId: "action-fixture" }, "rejected");
  apply({
    kind: "record_payment",
    total: proposal.total,
    evidenceRef: "synthetic:payment-observation",
  });
  apply({
    kind: "reconcile_handoff",
    actionId: "action-fixture",
    result: "unresolved",
    source: "operator_verified",
    evidenceRef: "synthetic:operator-no-answer",
    providerReference: null,
  });
  apply({
    kind: "reconcile_handoff",
    actionId: "action-fixture",
    result: "confirmed",
    source: "provider_lookup",
    evidenceRef: "synthetic:provider-lookup",
    providerReference: "booking-fixture",
  });
  apply({ kind: "record_fulfillment", evidenceRef: "synthetic:service-delivered" });
  apply({ kind: "close", outcome: "fulfilled" });
  const followup = createFollowupCase(state, {
    relationship,
    caseId: "case-fixture-2",
    sourceEvent: event,
    brief: { ...brief, id: "brief-fixture-2" },
    deadline: "2027-02-01T12:00:00Z",
  });
  return {
    evidenceLevel: "synthetic-domain-fixture" as const,
    actualModelCalls: 0,
    actualSupplierCalls: 0,
    relationship,
    trace,
    closedCase: state,
    followup,
  };
}
