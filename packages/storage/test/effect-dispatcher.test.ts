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

  async function setup(fault: SupplierFault = "dropResponseAfterAccept", lookup = true) {
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
        supportsIdempotency: lookup,
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
    await expect(recovered.dispatchApprovedHandoff(input)).rejects.toThrow(
      "reconciliation_required",
    );
    await recovered.reconcileUnknownAction(input);
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
