import { randomUUID } from "node:crypto";
import {
  type CaseAuthority,
  type CaseCommandBody,
  runCaseJourneyFixture,
} from "@occavoy/domain/case-lifecycle";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DeterministicEffectDispatcher } from "../src/effect-dispatcher";
import {
  FakeSupplierAdapter,
  type SupplierFault,
  UnsupportedCapabilityError,
} from "../src/fake-supplier";
import { applyMigrations } from "../src/migrations";
import { PostgresCaseStore } from "../src/postgres-case-store";

const now = new Date("2027-01-01T12:00:00Z");
const database = process.env.DATABASE_URL;

describe.skipIf(!database)("effect dispatcher (real Postgres, synthetic supplier)", () => {
  let pool: pg.Pool;
  let admin: pg.Pool;
  let store: PostgresCaseStore;
  const schema = `oca6_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: database });
    const create = await admin.query("SELECT format('CREATE SCHEMA %I', $1::text) AS ddl", [
      schema,
    ]);
    await admin.query(create.rows[0].ddl);
    pool = new pg.Pool({ connectionString: database, options: `-c search_path=${schema}` });
    await applyMigrations(pool);
    store = new PostgresCaseStore(pool);
  });
  afterAll(async () => {
    await pool?.end();
    if (pool) {
      const drop = await admin.query("SELECT format('DROP SCHEMA %I CASCADE', $1::text) AS ddl", [
        schema,
      ]);
      await admin.query(drop.rows[0].ddl);
    }
    await admin.end();
  });

  async function setup(
    fault: SupplierFault = "dropResponseAfterAccept",
    lookup = true,
    idempotency = lookup,
  ) {
    // Reuse the public London fixture's immutable terms, not its action or final state.
    const { relationship, closedCase: fixture } = runCaseJourneyFixture();
    const tenantId = `synthetic-${randomUUID()}`;
    const { caseId } = fixture.scope;
    const scope = { tenantId, caseId };
    const proposal = { ...fixture.proposals[0]!, ...scope };
    const approval = { ...fixture.approval!, ...scope };
    const authority: CaseAuthority = {
      ...scope,
      actorId: "runtime-fixture",
      grantId: "runtime-grant",
      validUntil: fixture.deadline,
      permissions: ["handoff.dispatch", "supply.record", "action.reconcile"],
    };
    const input = {
      ...scope,
      now,
      authority,
      actionId: "action-1",
      clientReference: "client-ref-1",
      requestHash: "synthetic:request-v1",
    };
    const supplier = new FakeSupplierAdapter(
      tenantId,
      {
        supplierId: proposal.scope.supplierId,
        destinations: ["GB"],
        currencies: ["GBP"],
        supportsLookup: lookup,
        supportsIdempotency: idempotency,
        supportsCancel: false,
      },
      fault,
    );
    const dispatcher = new DeterministicEffectDispatcher(store, supplier);
    await store.createCase({
      relationship: { ...relationship, tenantId },
      caseId,
      sourceEvent: fixture.sourceEvent,
      brief: fixture.brief,
      deadline: fixture.deadline,
    });
    const state = async () => (await store.getCase(tenantId, caseId))!;
    const submit = async (body: CaseCommandBody) =>
      (
        await store.submitCommand(
          {
            ...scope,
            ...body,
            expectedRevision: (await state()).revision,
            commandId: randomUUID(),
          },
          {
            now,
            authority: {
              ...authority,
              actorId: approval.approvedBy,
              grantId: approval.authorityGrantId,
              permissions: [
                ...authority.permissions,
                "case.edit",
                "agent.result",
                "supply.request",
                "proposal.write",
                "proposal.approve",
                "case.close",
                "fulfillment.record",
              ],
            },
          },
        )
      ).decision;
    async function apply(body: CaseCommandBody) {
      const result = await submit(body);
      expect(result.outcome, result.reason).toBe("applied");
      return result.state;
    }
    const activated = await apply({
      kind: "activate",
      taskId: "job-1",
      maxModelCalls: 1,
      maxToolCalls: 0,
    });
    await apply({
      kind: "agent_candidate",
      candidate: { task: activated.activeTask!, requirements: fixture.requirements },
    });
    await apply({ kind: "request_quote", rfq: fixture.rfq! });
    await apply({ kind: "record_quote", quote: { ...fixture.quotes[0]!, ...scope } });
    await apply({ kind: "stage_proposal", proposal });
    await apply({ kind: "publish_proposal" });
    await apply({ kind: "approve_proposal", approval });
    return { input, supplier, dispatcher, submit, apply, state, proposal };
  }

  it("commits intent before the lost response; a restarted dispatcher looks up exactly one original order", async () => {
    const { input, supplier, dispatcher, state, submit, apply, proposal } = await setup();
    const send = supplier.submitHandoff.bind(supplier);
    const spy = vi.spyOn(supplier, "submitHandoff").mockImplementation(async (req) => {
      const persisted = await pool.query(
        "SELECT * FROM case_external_actions WHERE tenant_id=$1 AND id=$2",
        [input.tenantId, input.actionId],
      );
      expect(persisted.rows).toMatchObject([
        {
          status: "dispatching",
          attempts: 1,
          client_reference: input.clientReference,
          request_hash: input.requestHash,
          proposal_version: "1",
        },
      ]);
      return send(req);
    });
    const unknown = await dispatcher.dispatchApprovedHandoff(input);
    expect(spy).toHaveBeenCalledWith({
      attempt: 1,
      actionId: input.actionId,
      clientReference: input.clientReference,
      requestHash: input.requestHash,
      proposalId: proposal.id,
      proposalVersion: proposal.version,
      total: proposal.total,
      validUntil: proposal.validUntil,
    });
    expect(unknown).toMatchObject({
      action: { status: "unknown", attempts: 1 },
      waitReason: "reconciliation",
      booking: "pending",
    });
    expect(supplier.orderCount).toBe(1);
    expect(await submit({ kind: "retry_handoff", actionId: input.actionId })).toMatchObject({
      outcome: "rejected",
      reason: "reconciliation_required",
    });
    const receipt = await supplier.lookupByClientReference(input.clientReference);
    if (!receipt.found) throw new Error("missing synthetic order");
    const payment = await apply({
      kind: "record_payment",
      total: proposal.total,
      evidenceRef: "synthetic:paid",
    });
    expect(payment).toMatchObject({ booking: "pending", payment: "paid", fulfillment: "pending" });
    const recovered = new DeterministicEffectDispatcher(new PostgresCaseStore(pool), supplier);
    const fenceSpy = vi.spyOn(supplier, "fenceHandoffAttempt");
    await expect(recovered.dispatchApprovedHandoff(input)).rejects.toThrow(
      "reconciliation_required",
    );
    await recovered.reconcileUnknownAction(input);
    expect(fenceSpy).not.toHaveBeenCalled();
    expect(await state()).toMatchObject({
      action: {
        status: "confirmed",
        attempts: 1,
        providerReference: receipt.providerReference,
        reconciliationEvidence: [{ source: "provider_lookup", result: "confirmed" }],
      },
      booking: "confirmed",
      payment: "paid",
      fulfillment: "pending",
    });
    expect(
      await submit({
        kind: "handoff_unknown",
        actionId: input.actionId,
        evidenceRef: "synthetic:late-timeout",
      }),
    ).toMatchObject({ outcome: "rejected", reason: "action_not_dispatching" });
    expect((await state()).action?.status).toBe("confirmed");
    expect(
      await apply({ kind: "record_fulfillment", evidenceRef: "synthetic:delivered" }),
    ).toMatchObject({ fulfillment: "completed", fulfillmentEvidence: "synthetic:delivered" });
    expect(supplier.submitCalls).toBe(1);
    expect(supplier.orderCount).toBe(1);
  });

  it("requires evidence from an operator without lookup; 'unresolved' never permits retry or close", async () => {
    const { input, supplier, dispatcher, submit } = await setup("dropResponseAfterAccept", false);
    await dispatcher.dispatchApprovedHandoff(input);
    await expect(supplier.lookupByClientReference(input.clientReference)).rejects.toThrow(
      UnsupportedCapabilityError,
    );
    expect(await dispatcher.reconcileUnknownAction(input)).toEqual({
      needsOperatorReconciliation: true,
    });
    const operator = {
      ...input,
      authority: { ...input.authority, actorId: "operator-1", grantId: "operator-grant" },
    };
    expect(
      await dispatcher.recordOperatorReconciliation({
        ...operator,
        result: "unresolved",
        providerReference: null,
        evidenceRef: "synthetic:still-investigating",
      }),
    ).toMatchObject({ action: { status: "unknown" }, waitReason: "reconciliation" });
    expect(await submit({ kind: "retry_handoff", actionId: input.actionId })).toMatchObject({
      outcome: "rejected",
      reason: "reconciliation_required",
    });
    expect(await submit({ kind: "close", outcome: "unavailable" })).toMatchObject({
      outcome: "rejected",
      reason: "external_obligation_unresolved",
    });
    const verified = await dispatcher.recordOperatorReconciliation({
      ...operator,
      result: "confirmed",
      providerReference: "synthetic:order:1",
      evidenceRef: "synthetic:operator-verified-receipt",
    });
    expect(verified.action).toMatchObject({
      status: "confirmed",
      providerReference: "synthetic:order:1",
      reconciliationEvidence: [
        { result: "unresolved", source: "operator_verified", recordedBy: "operator-1" },
        { result: "confirmed", source: "operator_verified", recordedBy: "operator-1" },
      ],
    });
    expect(supplier.submitCalls).toBe(1);
    expect(supplier.orderCount).toBe(1);
  });

  it("cancellation fences a new dispatch but preserves a late supplier confirmation", async () => {
    const { input, supplier, dispatcher, submit, apply, state } = await setup();
    await dispatcher.dispatchApprovedHandoff(input);
    await apply({ kind: "cancel", reason: "synthetic:cancel-request" });
    await expect(
      dispatcher.dispatchApprovedHandoff({ ...input, actionId: "action-2" }),
    ).rejects.toThrow("cancellation_requested");
    await dispatcher.reconcileUnknownAction(input);
    expect(await state()).toMatchObject({
      cancelRequested: true,
      waitReason: "reconciliation",
      booking: "confirmed",
      outcome: null,
    });
    expect(await submit({ kind: "close", outcome: "declined" })).toMatchObject({
      outcome: "rejected",
      reason: "supplier_cancellation_resolution_required",
    });
    expect(supplier.submitCalls).toBe(1);
  });

  it("can record positive operator evidence after a crash before the timeout was persisted", async () => {
    const { input, dispatcher, supplier, state } = await setup("dropResponseAfterAccept", false);
    const submit = store.submitCommand.bind(store);
    const fault = vi.spyOn(store, "submitCommand").mockImplementation((command, ctx) => {
      if (command.kind === "handoff_unknown") throw new Error("synthetic:local-write-lost");
      return submit(command, ctx);
    });
    try {
      await expect(dispatcher.dispatchApprovedHandoff(input)).rejects.toThrow(
        "synthetic:local-write-lost",
      );
    } finally {
      fault.mockRestore();
    }
    expect((await state()).action?.status).toBe("dispatching");
    const recovered = new DeterministicEffectDispatcher(new PostgresCaseStore(pool), supplier);
    const operator = {
      ...input,
      authority: { ...input.authority, actorId: "operator-1", grantId: "operator-grant" },
    };
    await expect(
      recovered.recordOperatorReconciliation({
        ...operator,
        result: "not_executed",
        providerReference: null,
        evidenceRef: "synthetic:not-yet-visible",
      }),
    ).rejects.toThrow("dispatch_still_in_flight");
    await recovered.recordOperatorReconciliation({
      ...operator,
      result: "confirmed",
      providerReference: "synthetic:order:1",
      evidenceRef: "synthetic:verified-receipt",
    });
    expect((await state()).action?.status).toBe("confirmed");
    expect(supplier.submitCalls).toBe(1);
    expect(supplier.orderCount).toBe(1);
  });

  it.each(["retry", "close"] as const)(
    "recovers a commit-before-send crash for explicit %s",
    async (resolution) => {
      const { input, supplier, dispatcher, state, apply } = await setup("none");
      const submit = store.submitCommand.bind(store);
      const crash = vi
        .spyOn(store, "submitCommand")
        .mockImplementationOnce(async (command, ctx) => {
          const intent = await submit(command, ctx);
          expect(intent.decision.outcome).toBe("applied");
          throw new Error("synthetic:crash-after-commit");
        });
      try {
        await expect(dispatcher.dispatchApprovedHandoff(input)).rejects.toThrow(
          "synthetic:crash-after-commit",
        );
      } finally {
        crash.mockRestore();
      }
      expect(await state()).toMatchObject({ action: { status: "dispatching", attempts: 1 } });
      expect(supplier.submitCalls).toBe(0);
      const recovered = new DeterministicEffectDispatcher(new PostgresCaseStore(pool), supplier);
      const target = { ...input, attempt: 1 };
      await expect(recovered.reconcileUnknownAction(input)).rejects.toThrow(
        "dispatch_still_in_flight",
      );
      await expect(
        recovered.recordOperatorReconciliation({
          ...input,
          result: "not_executed",
          providerReference: null,
          evidenceRef: "synthetic:negative",
        }),
      ).rejects.toThrow("dispatch_still_in_flight");
      await expect(recovered.retryApprovedHandoff(target)).rejects.toThrow(
        "reconciliation_required",
      );
      vi.spyOn(supplier, "fenceHandoffAttempt").mockRejectedValueOnce(
        new Error("fence unavailable"),
      );
      await expect(recovered.recoverInterruptedDispatch(target)).rejects.toThrow(
        "fence unavailable",
      );
      expect((await state()).action?.status).toBe("dispatching");
      const interrupted = await recovered.recoverInterruptedDispatch(target);
      expect(interrupted.action).toMatchObject({ status: "unknown", attempts: 1 });
      expect(interrupted.action?.attemptFences).toMatchObject([
        { clientReference: input.clientReference, attempt: 1 },
      ]);
      expect(interrupted.action?.evidenceRefs).toEqual([
        interrupted.action?.attemptFences[0]?.evidenceRef,
      ]);
      await expect(recovered.retryApprovedHandoff(target)).rejects.toThrow(
        "reconciliation_required",
      );
      await expect(recovered.reconcileUnknownAction(input)).resolves.toMatchObject({
        action: {
          status: "not_executed",
          reconciliationEvidence: [{ result: "not_executed", source: "provider_lookup" }],
        },
      });
      expect(supplier.orderCount).toBe(0);
      if (resolution === "retry") {
        await expect(recovered.retryApprovedHandoff(target)).resolves.toMatchObject({
          action: {
            status: "confirmed",
            attempts: 2,
            clientReference: input.clientReference,
            requestHash: input.requestHash,
          },
        });
        expect(supplier.orderCount).toBe(1);
        expect(supplier.submitCalls).toBe(1);
      } else {
        expect(await apply({ kind: "close", outcome: "unavailable" })).toMatchObject({
          phase: "closed",
        });
        expect(supplier.submitCalls).toBe(0);
      }
    },
  );

  it("a sender paused before acceptance cannot place its order after the fence", async () => {
    const { input, supplier, dispatcher } = await setup("none", false);
    let signalPaused!: () => void;
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      signalPaused = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const send = supplier.submitHandoff.bind(supplier);
    vi.spyOn(supplier, "submitHandoff").mockImplementationOnce(async (request) => {
      signalPaused();
      await resumed;
      return send(request);
    });
    const oldSender = dispatcher.dispatchApprovedHandoff(input);
    await paused;
    const target = { ...input, attempt: 1 };
    try {
      const fenced = await dispatcher.fenceActionAttempt(target);
      await expect(
        dispatcher.recordOperatorReconciliation({
          ...input,
          result: "not_executed",
          providerReference: null,
          evidenceRef: "synthetic:stale-operator-assertion",
        }),
      ).rejects.toThrow("terminal_nonexecution_proof_required");
      await dispatcher.recordOperatorReconciliation({
        ...input,
        result: "not_executed",
        providerReference: null,
        evidenceRef: "synthetic:operator-verified-absent",
        nonexecutionProof: { fenceId: fenced.fence.fenceId, attempt: 1 },
      });
      await dispatcher.retryApprovedHandoff(target);
    } finally {
      resume();
    }
    await expect(oldSender).rejects.toThrow("action_attempt_changed");
    expect(supplier.submitCalls).toBe(2);
    expect(supplier.orderCount).toBe(1);
  });

  it("fences a timeout before acceptance; retry and the delayed sender produce exactly one order", async () => {
    const { input, supplier, dispatcher } = await setup("none", true, false);
    let releaseOriginal!: () => void;
    const originalReleased = new Promise<void>((resolve) => {
      releaseOriginal = resolve;
    });
    let originalCompletion: Promise<void> = Promise.resolve();
    let originalError: unknown;
    const send = supplier.submitHandoff.bind(supplier);
    vi.spyOn(supplier, "submitHandoff").mockImplementationOnce(async (request) => {
      // The client-side response times out while the provider-side request remains in flight.
      originalCompletion = (async () => {
        await originalReleased;
        await send(request).catch((error) => {
          originalError = error;
        });
      })();
      throw new Error("synthetic:client-timeout");
    });
    const unknown = await dispatcher.dispatchApprovedHandoff(input);
    expect(unknown.action).toMatchObject({ status: "unknown", attempts: 1 });
    expect(supplier.orderCount).toBe(0);
    expect(supplier.submitCalls).toBe(0);

    const settled = await dispatcher.reconcileUnknownAction(input);
    if ("needsOperatorReconciliation" in settled)
      throw new Error("lookup unexpectedly unsupported");
    const fence = settled.action?.attemptFences.at(-1);
    expect(settled.action).toMatchObject({ status: "not_executed", attempts: 1 });
    expect(fence).toMatchObject({ clientReference: input.clientReference, attempt: 1 });
    expect(settled.action?.reconciliationEvidence.at(-1)).toMatchObject({
      result: "not_executed",
      source: "provider_lookup",
      attempt: 1,
      fenceId: fence?.fenceId,
    });
    const persisted = await pool.query(
      `SELECT attempt_fences FROM case_external_actions
       WHERE tenant_id = $1 AND id = $2`,
      [input.tenantId, input.actionId],
    );
    expect(persisted.rows[0]?.attempt_fences.at(-1)).toMatchObject({
      fenceId: fence?.fenceId,
      clientReference: input.clientReference,
      attempt: 1,
    });

    await dispatcher.retryApprovedHandoff({ ...input, attempt: 1 });
    expect(supplier.orderCount).toBe(1);
    expect(supplier.submitCalls).toBe(1);
    releaseOriginal();
    await originalCompletion;
    expect(originalError).toBeInstanceOf(Error);
    expect((originalError as Error).message).toBe("synthetic:attempt-fenced");
    expect(supplier.submitCalls).toBe(2);
    expect(supplier.orderCount).toBe(1);
  });

  it("acceptance between the first lookup and the fence reconciles confirmed rather than retrying", async () => {
    const { input, supplier, dispatcher } = await setup("none", true, false);
    let releaseAcceptance!: () => void;
    const acceptanceAllowed = new Promise<void>((resolve) => {
      releaseAcceptance = resolve;
    });
    let acceptanceCompleted: Promise<unknown> = Promise.resolve();
    const send = supplier.submitHandoff.bind(supplier);
    vi.spyOn(supplier, "submitHandoff").mockImplementationOnce(async (request) => {
      acceptanceCompleted = (async () => {
        await acceptanceAllowed;
        return send(request);
      })();
      throw new Error("synthetic:client-timeout");
    });
    const lookup = supplier.lookupByClientReference.bind(supplier);
    let lookups = 0;
    vi.spyOn(supplier, "lookupByClientReference").mockImplementation(async (clientReference) => {
      lookups += 1;
      if (lookups === 1) return { found: false };
      return lookup(clientReference);
    });
    const fence = supplier.fenceHandoffAttempt.bind(supplier);
    vi.spyOn(supplier, "fenceHandoffAttempt").mockImplementationOnce(async (target) => {
      // The first negative lookup has already returned when this in-flight request is accepted.
      releaseAcceptance();
      await acceptanceCompleted;
      return fence(target);
    });

    await dispatcher.dispatchApprovedHandoff(input);
    const reconciled = await dispatcher.reconcileUnknownAction(input);
    if ("needsOperatorReconciliation" in reconciled) {
      throw new Error("lookup unexpectedly unsupported");
    }
    expect(reconciled.action).toMatchObject({
      status: "confirmed",
      attempts: 1,
      providerReference: "synthetic:order:1",
    });
    expect(reconciled.action?.attemptFences).toHaveLength(1);
    await expect(dispatcher.retryApprovedHandoff({ ...input, attempt: 1 })).rejects.toThrow(
      "proof_of_nonexecution_required",
    );
    expect(supplier.submitCalls).toBe(1);
    expect(supplier.orderCount).toBe(1);
  });

  it.each([
    { mode: "failed", error: "fence unavailable" },
    { mode: "missing", error: "dispatch_fence_unavailable" },
  ] as const)("a $mode fence holds UNKNOWN and blocks retry", async ({ mode, error }) => {
    const { input, supplier, dispatcher, state } = await setup("rejectBeforeAccept", true, false);
    await dispatcher.dispatchApprovedHandoff(input);
    expect((await state()).action?.status).toBe("unknown");
    if (mode === "failed") {
      vi.spyOn(supplier, "fenceHandoffAttempt").mockRejectedValueOnce(new Error(error));
    } else {
      Object.defineProperty(supplier, "fenceHandoffAttempt", { value: undefined });
    }

    await expect(dispatcher.reconcileUnknownAction(input)).rejects.toThrow(error);
    expect((await state()).action).toMatchObject({ status: "unknown", attempts: 1 });
    await expect(dispatcher.retryApprovedHandoff({ ...input, attempt: 1 })).rejects.toThrow(
      "reconciliation_required",
    );
    expect(supplier.orderCount).toBe(0);
  });

  it("operator nonexecution evidence must cite the current recorded attempt fence", async () => {
    const { input, supplier, dispatcher, state } = await setup("none", false);
    vi.spyOn(supplier, "submitHandoff").mockImplementationOnce(async () => {
      throw new Error("synthetic:connection-refused-before-acceptance");
    });
    await dispatcher.dispatchApprovedHandoff(input);
    const operator = {
      ...input,
      authority: { ...input.authority, actorId: "operator-1", grantId: "operator-grant" },
    };
    const staleProof = { fenceId: "synthetic:assertion-before-fence", attempt: 1 };
    await expect(
      dispatcher.recordOperatorReconciliation({
        ...operator,
        result: "not_executed",
        providerReference: null,
        evidenceRef: "synthetic:stale-negative",
        nonexecutionProof: staleProof,
      }),
    ).rejects.toThrow("terminal_nonexecution_proof_required");
    await expect(dispatcher.retryApprovedHandoff({ ...input, attempt: 1 })).rejects.toThrow(
      "reconciliation_required",
    );

    const fenced = await dispatcher.fenceActionAttempt({ ...operator, attempt: 1 });
    const verified = await dispatcher.recordOperatorReconciliation({
      ...operator,
      result: "not_executed",
      providerReference: null,
      evidenceRef: "synthetic:operator-verified-after-fence",
      nonexecutionProof: { fenceId: fenced.fence.fenceId, attempt: 1 },
    });
    expect(verified.action).toMatchObject({ status: "not_executed", attempts: 1 });
    expect(verified.action?.reconciliationEvidence.at(-1)).toMatchObject({
      source: "operator_verified",
      result: "not_executed",
      attempt: 1,
      fenceId: fenced.fence.fenceId,
    });
    expect((await state()).booking).toBe("not_booked");
    await dispatcher.retryApprovedHandoff({ ...input, attempt: 1 });
    expect(supplier.orderCount).toBe(1);
  });

  it("refuses dispatch at the exact shared quote, proposal and approval expiry", async () => {
    const { input, supplier, dispatcher, state, proposal } = await setup();
    await expect(
      dispatcher.dispatchApprovedHandoff({ ...input, now: new Date(proposal.validUntil) }),
    ).rejects.toThrow("quote_expired_or_missing");
    expect((await state()).action).toBeNull();
    expect(supplier.submitCalls).toBe(0);
  });

  it("records proof of nonexecution only after lookup; never automatically resubmits", async () => {
    const { input, supplier, dispatcher, state } = await setup("rejectBeforeAccept");
    await dispatcher.dispatchApprovedHandoff(input);
    expect((await state()).action?.status).toBe("unknown");
    await dispatcher.reconcileUnknownAction(input);
    expect(await state()).toMatchObject({
      action: { status: "not_executed", providerReference: null },
      booking: "not_booked",
    });
    expect(supplier.orderCount).toBe(0);
    expect(supplier.submitCalls).toBe(1);
  });

  it("only the fresh intent submits, even with concurrent dispatch to a non-idempotent supplier", async () => {
    const { input, supplier, dispatcher, state } = await setup("none", false);
    const attempts = await Promise.allSettled([
      dispatcher.dispatchApprovedHandoff(input),
      dispatcher.dispatchApprovedHandoff(input),
    ]);
    expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    expect(await state()).toMatchObject({
      action: { status: "confirmed" },
      payment: "unobserved",
      fulfillment: "pending",
    });
    expect(supplier.orderCount).toBe(1);
    expect(supplier.submitCalls).toBe(1);
  });
});
