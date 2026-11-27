import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { demoEvents } from "@occavoy/domain";
import type {
  CaseAuthority,
  CaseCommandBody,
  CaseDecision,
  CasePermission,
  CaseSnapshot,
} from "@occavoy/domain/case-lifecycle";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/migrations";
import {
  CommandConflictError,
  PostgresCaseStore,
  type StoredCommandResult,
} from "../src/postgres-case-store";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN_DB = DATABASE_URL ? describe : describe.skip;

const NOW = new Date("2027-01-01T12:00:00Z");

const PERMISSIONS: Record<CaseCommandBody["kind"], CasePermission> = {
  activate: "case.edit",
  cancel: "case.edit",
  revise_brief: "case.edit",
  agent_candidate: "agent.result",
  agent_task_stopped: "agent.stop",
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

function actorFor(body: CaseCommandBody): string {
  if (body.kind === "approve_proposal") return "payer-fixture";
  if (body.kind === "record_quote") return "supplier-fixture";
  if (body.kind === "reconcile_handoff" && body.source === "operator_verified") {
    return "operator-fixture";
  }
  return "runtime-fixture";
}

interface Harness {
  tenantId: string;
  caseId: string;
  counter: number;
  state: CaseSnapshot;
  store: PostgresCaseStore;
  submit: (
    body: CaseCommandBody,
    overrides?: Partial<CaseAuthority>,
  ) => Promise<StoredCommandResult>;
  authority: (body: CaseCommandBody) => CaseAuthority;
}

function makeHarness(store: PostgresCaseStore, tenantId: string, caseId: string): Harness {
  const harness = {
    tenantId,
    caseId,
    counter: 0,
    state: null as unknown as CaseSnapshot,
    store,
    authority(body: CaseCommandBody): CaseAuthority {
      const actorId = actorFor(body);
      return {
        tenantId,
        caseId,
        actorId,
        grantId: actorId === "payer-fixture" ? "grant-payer" : `grant-${actorId}`,
        permissions: [PERMISSIONS[body.kind]],
        validUntil: "2027-01-10T12:00:00Z",
      };
    },
    async submit(body: CaseCommandBody, overrides?: Partial<CaseAuthority>) {
      harness.counter += 1;
      const authority = { ...harness.authority(body), ...overrides };
      const result = await store.submitCommand(
        {
          ...body,
          commandId: `${harness.caseId}-command-${harness.counter}`,
          tenantId: harness.tenantId,
          caseId: harness.caseId,
          expectedRevision: harness.state.revision,
        },
        { now: NOW, authority },
      );
      if (result.decision.outcome === "applied") harness.state = result.decision.state;
      return result;
    },
  };
  return harness;
}

async function createCase(
  store: PostgresCaseStore,
  tenantId: string,
  caseId: string,
  event = demoEvents[1]!,
  currency = "GBP",
) {
  const relationship = {
    id: `relationship-${tenantId}`,
    tenantId,
    customerId: `customer-${tenantId}`,
    preferenceReuseAllowed: true,
  };
  const snapshot = await store.createCase({
    relationship,
    caseId,
    sourceEvent: event,
    brief: {
      id: `brief-${caseId}`,
      version: 1,
      eventId: event.id,
      destination: event.destination,
      budget: { amountMinor: 100000, currency },
      approverActorId: "payer-fixture",
    },
    deadline: "2027-01-10T12:00:00Z",
  });
  const harness = makeHarness(store, tenantId, caseId);
  harness.state = snapshot;
  return { harness, snapshot };
}

function expectApplied(result: StoredCommandResult): CaseDecision {
  if (result.decision.outcome !== "applied") {
    throw new Error(`Expected applied, got ${result.decision.outcome}:${result.decision.reason}`);
  }
  return result.decision;
}

/** Replays the single-component synthetic journey end to end through the store. */
async function runJourney(harness: Harness) {
  const currency = harness.state.brief.budget.currency;
  expectApplied(
    await harness.submit({
      kind: "activate",
      taskId: `task-${harness.caseId}`,
      maxModelCalls: 2,
      maxToolCalls: 3,
    }),
  );
  const task = harness.state.activeTask;
  if (!task) throw new Error("Missing active task");
  expectApplied(
    await harness.submit({
      kind: "agent_candidate",
      candidate: {
        task,
        requirements: [
          { id: "hotel", category: "accommodation", description: "One room near the event" },
        ],
      },
    }),
  );
  expectApplied(
    await harness.submit({
      kind: "request_quote",
      rfq: {
        id: `rfq-${harness.caseId}`,
        supplierId: "supplier-fixture",
        briefVersion: 1,
        requirementIds: ["hotel"],
      },
    }),
  );
  const quote = {
    id: `quote-${harness.caseId}`,
    version: 1,
    tenantId: harness.tenantId,
    caseId: harness.caseId,
    rfqId: `rfq-${harness.caseId}`,
    briefVersion: 1,
    supplierId: "supplier-fixture",
    sellerId: "seller-fixture",
    fulfillerId: "hotel-fixture",
    payeeId: "seller-fixture",
    total: { amountMinor: 30000, currency },
    validUntil: "2027-01-02T12:00:00Z",
    availability: "quoted" as const,
    evidenceRef: "synthetic:quote-response",
  };
  expectApplied(await harness.submit({ kind: "record_quote", quote }));
  const proposal = {
    id: `proposal-${harness.caseId}`,
    version: 1,
    tenantId: harness.tenantId,
    caseId: harness.caseId,
    briefVersion: 1,
    quoteId: quote.id,
    quoteVersion: 1,
    termsHash: "synthetic:terms-v1",
    total: quote.total,
    validUntil: quote.validUntil,
    approverActorId: "payer-fixture",
    scope: {
      kind: "supplier_handoff" as const,
      supplierId: quote.supplierId,
      lineIds: [quote.id],
    },
  };
  expectApplied(await harness.submit({ kind: "stage_proposal", proposal }));
  expectApplied(await harness.submit({ kind: "publish_proposal" }));
  expectApplied(
    await harness.submit({
      kind: "approve_proposal",
      approval: {
        id: `approval-${harness.caseId}`,
        tenantId: harness.tenantId,
        caseId: harness.caseId,
        proposalId: proposal.id,
        proposalVersion: 1,
        termsHash: proposal.termsHash,
        total: proposal.total,
        validUntil: proposal.validUntil,
        scope: proposal.scope,
        approvedBy: "payer-fixture",
        authorityGrantId: "grant-payer",
        approvedAt: NOW.toISOString(),
      },
    }),
  );
  expectApplied(
    await harness.submit({
      kind: "dispatch_handoff",
      actionId: `action-${harness.caseId}`,
      clientReference: `client-ref-${harness.caseId}`,
      requestHash: "synthetic:request-v1",
    }),
  );
  expectApplied(
    await harness.submit({
      kind: "handoff_unknown",
      actionId: `action-${harness.caseId}`,
      evidenceRef: "synthetic:lost-response",
    }),
  );
  const blockedRetry = await harness.submit({
    kind: "retry_handoff",
    actionId: `action-${harness.caseId}`,
  });
  expect(blockedRetry.decision).toMatchObject({
    outcome: "rejected",
    reason: "reconciliation_required",
  });
  expectApplied(
    await harness.submit({
      kind: "record_payment",
      total: proposal.total,
      evidenceRef: "synthetic:payment-observation",
    }),
  );
  expectApplied(
    await harness.submit({
      kind: "reconcile_handoff",
      actionId: `action-${harness.caseId}`,
      result: "unresolved",
      source: "operator_verified",
      evidenceRef: "synthetic:operator-no-answer",
      providerReference: null,
    }),
  );
  expectApplied(
    await harness.submit({
      kind: "reconcile_handoff",
      actionId: `action-${harness.caseId}`,
      result: "confirmed",
      source: "provider_lookup",
      evidenceRef: "synthetic:provider-lookup",
      providerReference: `booking-${harness.caseId}`,
    }),
  );
  expectApplied(
    await harness.submit({
      kind: "record_fulfillment",
      evidenceRef: "synthetic:service-delivered",
    }),
  );
  expectApplied(await harness.submit({ kind: "close", outcome: "fulfilled" }));
  return { quote, proposal };
}

RUN_DB("postgres case store (requires DATABASE_URL)", () => {
  let pool: pg.Pool;
  let admin: pg.Pool;
  let store: PostgresCaseStore;
  const schema = `oca4_${randomUUID().replaceAll("-", "")}`;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DATABASE_URL });
    const create = await admin.query("SELECT format('CREATE SCHEMA %I', $1::text) AS ddl", [
      schema,
    ]);
    await admin.query(create.rows[0].ddl);
    pool = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${schema}` });
    store = new PostgresCaseStore(pool);
    await applyMigrations(pool);
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      const drop = await admin.query("SELECT format('DROP SCHEMA %I CASCADE', $1::text) AS ddl", [
        schema,
      ]);
      await admin.query(drop.rows[0].ddl);
      await admin.end();
    }
  });

  const tenant = () => `test-${randomUUID()}`;

  it("applies migrations idempotently and rolls a failing migration back cleanly", async () => {
    const recorded = await pool.query("SELECT version FROM schema_migrations ORDER BY version");
    expect(recorded.rows.map((row) => row.version)).toEqual(
      expect.arrayContaining([
        "001_quota",
        "002_case_core",
        "003_attempt_fences",
        "003_quota_reconciliation",
        "004_usage_allowances",
        "005_case_job_request_scope",
        "006_agent_intervention",
        "007_outbox_dispatched_index",
      ]),
    );
    expect(await applyMigrations(pool)).toEqual([]);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO schema_migrations (version) VALUES ('999_broken')");
      await expect(client.query("SELECT definitely_not_a_column")).rejects.toThrow();
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    const check = await pool.query(
      "SELECT version FROM schema_migrations WHERE version = '999_broken'",
    );
    expect(check.rowCount).toBe(0);
  });

  it("serializes concurrent first-time initialization in the same schema", async () => {
    const schema = `mig_race_${randomUUID().replaceAll("-", "")}`;
    const poolA = new pg.Pool({
      connectionString: DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const poolB = new pg.Pool({
      connectionString: DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    try {
      await pool.query(`CREATE SCHEMA ${schema}`);
      const [appliedA, appliedB] = await Promise.all([
        applyMigrations(poolA),
        applyMigrations(poolB),
      ]);
      const versions = readdirSync(new URL("../sql/", import.meta.url))
        .filter((file) => file.endsWith(".sql"))
        .map((file) => file.slice(0, -4))
        .sort();
      expect([...appliedA, ...appliedB].sort()).toEqual(versions);
      const recorded = await pool.query(
        `SELECT version FROM ${schema}.schema_migrations ORDER BY version`,
      );
      expect(recorded.rows.map((row) => row.version)).toEqual(versions);
    } finally {
      await poolA.end();
      await poolB.end();
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });

  it("allows the same agent request in different cases of one tenant", async () => {
    const tenantId = tenant();
    const ids = ["case-a", "case-b"];
    for (const id of ids) {
      const { harness } = await createCase(store, tenantId, id);
      expectApplied(
        await harness.submit({
          kind: "activate",
          taskId: "shared-task",
          maxModelCalls: 1,
          maxToolCalls: 0,
        }),
      );
    }
    const jobs = await pool.query(
      `SELECT case_id, task_id, request_id FROM case_agent_jobs
       WHERE tenant_id = $1 ORDER BY case_id`,
      [tenantId],
    );
    expect(jobs.rows).toEqual(
      ids.map((case_id) => ({ case_id, task_id: "shared-task", request_id: "shared-task" })),
    );
  });

  it.each([
    ["London", "GBP"],
    ["Tokyo", "JPY"],
    ["Singapore", "SGD"],
  ])("persists the full single-component journey for %s", async (city, currency) => {
    const tenantId = `${tenant()}-${city}`;
    const event = demoEvents.find((item) => item.destination.city === city);
    if (!event) throw new Error("Missing synthetic event");
    const { harness } = await createCase(store, tenantId, `case-${city}-1`, event, currency);
    const { quote, proposal } = await runJourney(harness);
    const closed = await store.getCase(tenantId, harness.caseId);
    expect(closed).toMatchObject({
      revision: harness.state.revision,
      phase: "closed",
      outcome: "fulfilled",
      booking: "confirmed",
      payment: "paid",
      fulfillment: "completed",
      cancelRequested: false,
    });

    const rows = async (table: string, extra = "") => {
      const result = await pool.query(
        `SELECT * FROM ${table} WHERE tenant_id = $1 AND case_id = $2 ${extra}`,
        [tenantId, harness.caseId],
      );
      return result.rows;
    };
    const caseRow = await pool.query(
      "SELECT * FROM service_cases WHERE tenant_id = $1 AND id = $2",
      [tenantId, harness.caseId],
    );
    expect(caseRow.rows[0]).toMatchObject({
      seller_id: "seller-fixture",
      fulfiller_id: "hotel-fixture",
      payer_id: "payer-fixture",
    });
    const quotes = await rows("case_quotes");
    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({
      id: quote.id,
      version: "1",
      amount_minor: "30000",
      currency,
      availability: "quoted",
      supplier_id: "supplier-fixture",
      fulfiller_id: "hotel-fixture",
    });
    const proposals = await rows("case_proposals");
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      id: proposal.id,
      quote_id: quote.id,
      terms_hash: "synthetic:terms-v1",
      currency,
    });
    const approvals = await rows("case_approvals");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      proposal_id: proposal.id,
      approved_by: "payer-fixture",
      authority_grant_id: "grant-payer",
    });
    const actions = await rows("case_external_actions");
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      status: "confirmed",
      attempts: 1,
      provider_reference: `booking-${harness.caseId}`,
      client_reference: `client-ref-${harness.caseId}`,
    });
    const jobs = await rows("case_agent_jobs");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ task_id: `task-${harness.caseId}`, status: "completed" });
    const commands = await rows("case_commands");
    expect(commands.every((row) => row.status === "completed")).toBe(true);
    expect(commands.filter((row) => row.outcome === "applied")).toHaveLength(14);
    const events = await store.getTimeline(tenantId, harness.caseId);
    expect(events[0]?.eventKind).toBe("case_created");
    expect(events.filter((row) => row.eventKind === "command.close")).toHaveLength(1);
    expect(events.filter((row) => row.eventKind.startsWith("intent."))).toHaveLength(3);
    const outbox = await store.listOutboxForCase(tenantId, harness.caseId);
    expect(outbox.map((row) => row.intentKind).sort()).toEqual([
      "request_supplier_quote",
      "run_agent_task",
      "supplier_handoff",
    ]);
    expect(outbox.every((row) => row.status === "pending")).toBe(true);

    const followupId = `case-${city}-2`;
    await store.createCase({
      relationship: {
        id: `relationship-${tenantId}`,
        tenantId,
        customerId: `customer-${tenantId}`,
        preferenceReuseAllowed: true,
      },
      caseId: followupId,
      sourceEvent: event,
      brief: {
        id: `brief-${followupId}`,
        version: 1,
        eventId: event.id,
        destination: event.destination,
        budget: { amountMinor: 80000, currency },
        approverActorId: "payer-fixture",
      },
      deadline: "2027-02-01T12:00:00Z",
    });
    const followup = await store.getCase(tenantId, followupId);
    expect(followup).toMatchObject({ phase: "draft", approval: null, action: null });
    const relationships = await pool.query(
      "SELECT id FROM customer_relationships WHERE tenant_id = $1",
      [tenantId],
    );
    expect(relationships.rows).toHaveLength(1);
  });

  it("completes a received command once after a crash between receive and complete", async () => {
    const tenantId = tenant();
    const { harness } = await createCase(store, tenantId, "case-crash");
    const body: CaseCommandBody = {
      kind: "activate",
      taskId: "task-crash",
      maxModelCalls: 2,
      maxToolCalls: 3,
    };
    const command = {
      ...body,
      commandId: `${harness.caseId}-crash-command`,
      tenantId,
      caseId: harness.caseId,
      expectedRevision: 0,
    };
    const authority = harness.authority(body);
    const receipt = await store.receiveCommand(command, authority);
    expect(receipt).toEqual({ status: "received", deduplicated: false });
    const stored = await store.getCommand(tenantId, command.commandId);
    expect(stored?.status).toBe("received");
    // Simulated restart: completion runs from the persisted command payload alone.
    const completed = await store.completeReceivedCommand(tenantId, command.commandId, {
      now: NOW,
      authority,
    });
    expect(completed.deduplicated).toBe(false);
    expect(completed.decision.outcome).toBe("applied");
    expect(completed.outboxIds).toHaveLength(1);
    const again = await store.completeReceivedCommand(tenantId, command.commandId, {
      now: NOW,
      authority,
    });
    expect(again.deduplicated).toBe(true);
    expect(again.outboxIds).toEqual(completed.outboxIds);
    const viaSubmit = await store.submitCommand(command, { now: NOW, authority });
    expect(viaSubmit.deduplicated).toBe(true);
    const viaReceive = await store.receiveCommand(command, authority);
    expect(viaReceive).toMatchObject({ status: "completed", deduplicated: true });
    const outbox = await store.listOutboxForCase(tenantId, harness.caseId);
    expect(outbox).toHaveLength(1);
    const snapshot = await store.getCase(tenantId, harness.caseId);
    expect(snapshot?.revision).toBe(1);
  });

  it("rejects a reused command id with a different payload without mutating state", async () => {
    const tenantId = tenant();
    const { harness } = await createCase(store, tenantId, "case-conflict");
    const command = {
      kind: "activate" as const,
      taskId: "task-a",
      maxModelCalls: 2,
      maxToolCalls: 3,
      commandId: `${harness.caseId}-dup`,
      tenantId,
      caseId: harness.caseId,
      expectedRevision: 0,
    };
    const authority = harness.authority(command);
    await store.submitCommand(command, { now: NOW, authority });
    const different = { ...command, maxModelCalls: 9 };
    await expect(store.submitCommand(different, { now: NOW, authority })).rejects.toThrow(
      CommandConflictError,
    );
    const reordered = {
      expectedRevision: 0,
      caseId: harness.caseId,
      tenantId,
      commandId: `${harness.caseId}-dup`,
      maxToolCalls: 3,
      maxModelCalls: 2,
      taskId: "task-a",
      kind: "activate" as const,
    };
    const deduped = await store.submitCommand(reordered, { now: NOW, authority });
    expect(deduped.deduplicated).toBe(true);
    const snapshot = await store.getCase(tenantId, harness.caseId);
    expect(snapshot?.revision).toBe(1);
    expect(await store.listOutboxForCase(tenantId, harness.caseId)).toHaveLength(1);
  });

  it("recovers an outbox intent committed but never delivered", async () => {
    const tenantId = tenant();
    const { harness } = await createCase(store, tenantId, "case-outbox");
    expectApplied(
      await harness.submit({
        kind: "activate",
        taskId: "task-outbox",
        maxModelCalls: 2,
        maxToolCalls: 3,
      }),
    );
    const claimed = await store.claimPendingOutbox(10, { tenantId });
    const mine = claimed.filter(
      (row) => row.tenantId === tenantId && row.caseId === harness.caseId,
    );
    expect(mine).toHaveLength(1);
    const claimedItem = mine[0];
    if (!claimedItem) throw new Error("Missing claimed outbox item");
    expect(claimedItem).toMatchObject({
      intentKind: "run_agent_task",
      status: "dispatched",
      attempts: 1,
    });
    await store.requeueOutbox(claimedItem.id);
    const reclaimed = await store.claimPendingOutbox(10, { tenantId });
    const again = reclaimed.filter((row) => row.id === claimedItem.id);
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ status: "dispatched", attempts: 2 });
    await store.completeOutbox(claimedItem.id);
    const remaining = await store.listOutboxForCase(tenantId, harness.caseId);
    expect(remaining[0]).toMatchObject({ status: "completed", attempts: 2 });
    expect(
      (await store.claimPendingOutbox(10, { tenantId })).filter((row) => row.id === claimedItem.id),
    ).toEqual([]);
  });

  it("reclaims a stranded dispatched lease after the lease timeout without requeue", async () => {
    const tenantId = tenant();
    const { harness } = await createCase(store, tenantId, "case-lease");
    expectApplied(
      await harness.submit({
        kind: "activate",
        taskId: "task-lease",
        maxModelCalls: 2,
        maxToolCalls: 3,
      }),
    );
    // Simulated restart: a fresh store instance observes the stranded claim.
    const freshStore = new PostgresCaseStore(pool);
    const t0 = new Date("2027-01-01T00:00:00Z");
    // Keep eligibility and lease expiry on the same simulated clock.
    const seeded = await pool.query(
      `UPDATE case_outbox SET available_at = $3 WHERE tenant_id = $1 AND case_id = $2`,
      [tenantId, harness.caseId, t0],
    );
    expect(seeded.rowCount).toBe(1);
    const claimed = await freshStore.claimPendingOutbox(10, { tenantId, now: t0 });
    const mine = claimed.filter(
      (row) => row.tenantId === tenantId && row.caseId === harness.caseId,
    );
    expect(mine).toHaveLength(1);
    const claimedItem = mine[0];
    if (!claimedItem) throw new Error("Missing claimed outbox item");
    // Within the 60s lease the row stays claimed and invisible to other workers.
    expect(
      await freshStore.claimPendingOutbox(10, {
        tenantId,
        now: new Date(t0.getTime() + 10_000),
      }),
    ).toEqual([]);
    // Past the lease the stranded dispatch is reclaimed without requeueOutbox.
    const reclaimed = await freshStore.claimPendingOutbox(10, {
      tenantId,
      now: new Date(t0.getTime() + 61_000),
    });
    const again = reclaimed.filter((row) => row.id === claimedItem.id);
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ status: "dispatched", attempts: 2 });
    // The explicit stale-scan path resets it to pending for the next claim.
    const reset = await freshStore.reclaimStaleOutbox({
      tenantId,
      now: new Date(t0.getTime() + 2 * 61_000),
    });
    expect(reset.filter((row) => row.id === claimedItem.id)).toHaveLength(1);
    const rows = await store.listOutboxForCase(tenantId, harness.caseId);
    expect(rows[0]?.status).toBe("pending");
  });

  it("projects commercial parties from the selected proposal and current brief", async () => {
    const tenantId = tenant();
    const { harness } = await createCase(store, tenantId, "case-parties");
    const parties = async () => {
      const result = await pool.query(
        `SELECT seller_id, fulfiller_id, payer_id FROM service_cases
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, harness.caseId],
      );
      return result.rows[0];
    };
    expect(await parties()).toMatchObject({
      seller_id: null,
      fulfiller_id: null,
      payer_id: "payer-fixture",
    });
    // Revising the brief swaps the payer and clears any stale supplier parties.
    expectApplied(
      await harness.submit({
        kind: "revise_brief",
        brief: {
          ...harness.state.brief,
          version: 2,
          approverActorId: "payer-updated",
        },
      }),
    );
    expect(await parties()).toMatchObject({
      seller_id: null,
      fulfiller_id: null,
      payer_id: "payer-updated",
    });
    expectApplied(
      await harness.submit({
        kind: "activate",
        taskId: `task-${harness.caseId}`,
        maxModelCalls: 2,
        maxToolCalls: 3,
      }),
    );
    const task = harness.state.activeTask;
    if (!task) throw new Error("Missing active task");
    expectApplied(
      await harness.submit({
        kind: "agent_candidate",
        candidate: {
          task,
          requirements: [
            { id: "hotel", category: "accommodation", description: "One room near the event" },
          ],
        },
      }),
    );
    expectApplied(
      await harness.submit({
        kind: "request_quote",
        rfq: {
          id: `rfq-${harness.caseId}`,
          supplierId: "supplier-fixture",
          briefVersion: 2,
          requirementIds: ["hotel"],
        },
      }),
    );
    const quoteFor = (id: string, sellerId: string, fulfillerId: string) => ({
      id,
      version: 1,
      tenantId,
      caseId: harness.caseId,
      rfqId: `rfq-${harness.caseId}`,
      briefVersion: 2,
      supplierId: "supplier-fixture",
      sellerId,
      fulfillerId,
      payeeId: sellerId,
      total: { amountMinor: 30000, currency: "GBP" },
      validUntil: "2027-01-02T12:00:00Z",
      availability: "quoted" as const,
      evidenceRef: `synthetic:${id}`,
    });
    const quoteA = quoteFor(`quote-a-${harness.caseId}`, "seller-a", "fulfiller-a");
    const quoteB = quoteFor(`quote-b-${harness.caseId}`, "seller-b", "fulfiller-b");
    expectApplied(await harness.submit({ kind: "record_quote", quote: quoteA }));
    expectApplied(await harness.submit({ kind: "record_quote", quote: quoteB }));
    // Without a proposal yet, the latest quote for the current brief wins.
    expect(await parties()).toMatchObject({
      seller_id: "seller-b",
      fulfiller_id: "fulfiller-b",
    });
    const proposalFor = (version: number, quote: typeof quoteA) => ({
      id: `proposal-${harness.caseId}`,
      version,
      tenantId,
      caseId: harness.caseId,
      briefVersion: 2,
      quoteId: quote.id,
      quoteVersion: 1,
      termsHash: `synthetic:terms-v${version}`,
      total: quote.total,
      validUntil: quote.validUntil,
      approverActorId: "payer-updated",
      scope: {
        kind: "supplier_handoff" as const,
        supplierId: quote.supplierId,
        lineIds: [quote.id],
      },
    });
    expectApplied(
      await harness.submit({ kind: "stage_proposal", proposal: proposalFor(1, quoteB) }),
    );
    expect(await parties()).toMatchObject({
      seller_id: "seller-b",
      fulfiller_id: "fulfiller-b",
    });
    // A re-staged proposal re-selects its own quote; parties are never frozen
    // on the first recorded quote.
    expectApplied(
      await harness.submit({ kind: "stage_proposal", proposal: proposalFor(2, quoteA) }),
    );
    expect(await parties()).toMatchObject({
      seller_id: "seller-a",
      fulfiller_id: "fulfiller-a",
    });
  });

  it("serializes a concurrent approve vs cancel so exactly one applies", async () => {
    const tenantId = tenant();
    const { harness } = await createCase(store, tenantId, "case-race");
    const { proposal } = await runJourneyUpToApproval(harness);
    const approveBody: CaseCommandBody = {
      kind: "approve_proposal",
      approval: {
        id: `approval-${harness.caseId}`,
        tenantId,
        caseId: harness.caseId,
        proposalId: proposal.id,
        proposalVersion: 1,
        termsHash: proposal.termsHash,
        total: proposal.total,
        validUntil: proposal.validUntil,
        scope: proposal.scope,
        approvedBy: "payer-fixture",
        authorityGrantId: "grant-payer",
        approvedAt: NOW.toISOString(),
      },
    };
    const cancelBody: CaseCommandBody = { kind: "cancel", reason: "Changed plans" };
    const [approve, cancel] = await Promise.all([
      harness.submit(approveBody),
      harness.submit(cancelBody),
    ]);
    const outcomes = [approve.decision.outcome, cancel.decision.outcome].sort();
    expect(outcomes).toEqual(["applied", "rejected"]);
    const loser = approve.decision.outcome === "applied" ? cancel : approve;
    expect(loser.decision.reason).toBe("stale_case_revision");
    const snapshot = await store.getCase(tenantId, harness.caseId);
    expect(snapshot?.revision).toBe(harness.state.revision);
    const revisions = await pool.query(
      `SELECT revision FROM service_cases WHERE tenant_id = $1 AND id = $2`,
      [tenantId, harness.caseId],
    );
    expect(Number(revisions.rows[0].revision)).toBe(harness.state.revision);
    const applied = await pool.query(
      `SELECT COUNT(*)::int AS n FROM case_commands
       WHERE tenant_id = $1 AND case_id = $2 AND outcome = 'applied'`,
      [tenantId, harness.caseId],
    );
    expect(applied.rows[0].n).toBe(harness.state.revision);
  });

  it("fences authority scope, stale candidates, expired grants and immutable records", async () => {
    const tenantId = tenant();
    const { harness } = await createCase(store, tenantId, "case-fence");
    const otherTenant = tenant();
    const wrongTenant = await harness.submit(
      { kind: "activate", taskId: "task-x", maxModelCalls: 1, maxToolCalls: 0 },
      { tenantId: otherTenant },
    );
    expect(wrongTenant.decision).toMatchObject({
      outcome: "rejected",
      reason: "authority_or_scope_mismatch",
    });
    const expired = await harness.submit(
      { kind: "activate", taskId: "task-x", maxModelCalls: 1, maxToolCalls: 0 },
      { validUntil: "2026-12-01T00:00:00Z" },
    );
    expect(expired.decision).toMatchObject({
      outcome: "rejected",
      reason: "authority_or_scope_mismatch",
    });
    expect((await store.getCase(tenantId, harness.caseId))?.revision).toBe(0);

    expectApplied(
      await harness.submit({
        kind: "activate",
        taskId: "task-stale",
        maxModelCalls: 2,
        maxToolCalls: 3,
      }),
    );
    const staleTask = harness.state.activeTask;
    if (!staleTask) throw new Error("Missing task");
    expectApplied(
      await harness.submit({
        kind: "revise_brief",
        brief: {
          ...harness.state.brief,
          version: 2,
          budget: { amountMinor: 90000, currency: "GBP" },
        },
      }),
    );
    const late = await harness.submit({
      kind: "agent_candidate",
      candidate: {
        task: staleTask,
        requirements: [{ id: "hotel", category: "accommodation", description: "Late" }],
      },
    });
    expect(late.decision).toMatchObject({ outcome: "ignored", reason: "stale_agent_candidate" });

    const { proposal } = await runJourneyUpToApproval(harness);
    const quote = harness.state.quotes[0];
    if (!quote) throw new Error("Missing quote");
    const duplicate = await harness.submit({ kind: "record_quote", quote });
    expect(duplicate.decision).toMatchObject({ outcome: "ignored", reason: "duplicate_quote" });
    const conflict = await harness.submit({
      kind: "record_quote",
      quote: { ...quote, total: { ...quote.total, amountMinor: 1 } },
    });
    expect(conflict.decision).toMatchObject({
      outcome: "rejected",
      reason: "immutable_quote_conflict",
    });
    const quoteRows = await pool.query(
      "SELECT COUNT(*)::int AS n FROM case_quotes WHERE tenant_id = $1 AND case_id = $2",
      [tenantId, harness.caseId],
    );
    expect(quoteRows.rows[0].n).toBe(1);
    expect(proposal.version).toBe(1);
  });
});

/** Drives a fresh case up to (not including) approval for concurrency/fencing tests. */
async function runJourneyUpToApproval(harness: Harness) {
  const currency = harness.state.brief.budget.currency;
  expectApplied(
    await harness.submit({
      kind: "activate",
      taskId: `task-${harness.caseId}-pre`,
      maxModelCalls: 2,
      maxToolCalls: 3,
    }),
  );
  const task = harness.state.activeTask;
  if (!task) throw new Error("Missing active task");
  expectApplied(
    await harness.submit({
      kind: "agent_candidate",
      candidate: {
        task,
        requirements: [
          { id: "hotel", category: "accommodation", description: "One room near the event" },
        ],
      },
    }),
  );
  expectApplied(
    await harness.submit({
      kind: "request_quote",
      rfq: {
        id: `rfq-${harness.caseId}-pre`,
        supplierId: "supplier-fixture",
        briefVersion: harness.state.brief.version,
        requirementIds: ["hotel"],
      },
    }),
  );
  const quote = {
    id: `quote-${harness.caseId}-pre`,
    version: 1,
    tenantId: harness.tenantId,
    caseId: harness.caseId,
    rfqId: `rfq-${harness.caseId}-pre`,
    briefVersion: harness.state.brief.version,
    supplierId: "supplier-fixture",
    sellerId: "seller-fixture",
    fulfillerId: "hotel-fixture",
    payeeId: "seller-fixture",
    total: { amountMinor: 30000, currency },
    validUntil: "2027-01-02T12:00:00Z",
    availability: "quoted" as const,
    evidenceRef: "synthetic:quote-response",
  };
  expectApplied(await harness.submit({ kind: "record_quote", quote }));
  const proposal = {
    id: `proposal-${harness.caseId}`,
    version: 1,
    tenantId: harness.tenantId,
    caseId: harness.caseId,
    briefVersion: quote.briefVersion,
    quoteId: quote.id,
    quoteVersion: 1,
    termsHash: "synthetic:terms-v1",
    total: quote.total,
    validUntil: quote.validUntil,
    approverActorId: "payer-fixture",
    scope: {
      kind: "supplier_handoff" as const,
      supplierId: quote.supplierId,
      lineIds: [quote.id],
    },
  };
  expectApplied(await harness.submit({ kind: "stage_proposal", proposal }));
  expectApplied(await harness.submit({ kind: "publish_proposal" }));
  return { quote, proposal };
}
