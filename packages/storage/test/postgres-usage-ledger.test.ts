import { randomUUID } from "node:crypto";
import { demoEvents } from "@occavoy/domain";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/migrations";
import { PostgresCaseStore } from "../src/postgres-case-store";
import { PostgresUsageLedger } from "../src/postgres-usage-ledger";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN_DB = DATABASE_URL ? describe : describe.skip;

async function createCaseFixture(store: PostgresCaseStore, tenantId: string, caseId: string) {
  const event = demoEvents[1]!;
  return store.createCase({
    relationship: {
      id: `relationship-${tenantId}`,
      tenantId,
      customerId: `customer-${tenantId}`,
      preferenceReuseAllowed: true,
    },
    caseId,
    sourceEvent: event,
    brief: {
      id: `brief-${caseId}`,
      version: 1,
      eventId: event.id,
      destination: event.destination,
      budget: { amountMinor: 100000, currency: "GBP" },
      approverActorId: "payer-fixture",
    },
    deadline: "2027-01-10T12:00:00Z",
  });
}

async function insertRunningJob(
  pool: pg.Pool,
  input: {
    tenantId: string;
    caseId: string;
    taskId: string;
    maxModelCalls?: number;
    maxToolCalls?: number;
  },
) {
  await pool.query(
    `INSERT INTO case_agent_jobs
      (tenant_id, case_id, task_id, request_id, brief_version, case_revision,
       max_model_calls, max_tool_calls, deadline, status)
     VALUES ($1, $2, $3, $4, 1, 1, $5, $6, '2027-01-10T12:00:00Z', 'running')`,
    [
      input.tenantId,
      input.caseId,
      input.taskId,
      `request-${input.caseId}-${input.taskId}`,
      input.maxModelCalls ?? 10,
      input.maxToolCalls ?? 10,
    ],
  );
}

RUN_DB("postgres usage ledger (requires DATABASE_URL)", () => {
  let pool: pg.Pool;
  let store: PostgresCaseStore;
  let ledger: PostgresUsageLedger;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    store = new PostgresCaseStore(pool);
    ledger = new PostgresUsageLedger(pool);
    await applyMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("persists reservation counters across a ledger instance replacement", async () => {
    const tenantId = `usage-restart-${randomUUID()}`;
    const snapshot = await createCaseFixture(store, tenantId, "case-usage-restart");
    await ledger.initializeAllowance({
      tenantId,
      caseId: snapshot.scope.caseId,
      maxModelCalls: 3,
      maxToolCalls: 2,
      maxCostMinor: 500,
      currency: "GBP",
    });
    await insertRunningJob(pool, {
      tenantId,
      caseId: snapshot.scope.caseId,
      taskId: "task-restart",
    });
    const first = await ledger.reserveUsage({
      tenantId,
      relationshipId: snapshot.scope.relationshipId,
      caseId: snapshot.scope.caseId,
      taskId: "task-restart",
      kind: "model_call",
      quantity: 1,
      costMinor: 125,
      currency: "GBP",
      metadata: { costCategory: "production_api", provider: "synthetic" },
    });
    expect(first.admitted).toBe(true);

    // Simulated process restart: a new adapter instance reads the same authoritative counters.
    const restartedLedger = new PostgresUsageLedger(pool);
    const allowance = await restartedLedger.getAllowance(tenantId, snapshot.scope.caseId);
    expect(allowance).toMatchObject({
      usedModelCalls: 1,
      usedToolCalls: 0,
      usedCostMinor: 125,
      status: "active",
    });
    const second = await restartedLedger.reserveUsage({
      tenantId,
      relationshipId: snapshot.scope.relationshipId,
      caseId: snapshot.scope.caseId,
      taskId: "task-restart",
      kind: "tool_call",
      quantity: 1,
      costMinor: 25,
      currency: "GBP",
      metadata: { costCategory: "rivet_runtime" },
    });
    expect(second.admitted).toBe(true);
    expect(second.allowance).toMatchObject({
      usedModelCalls: 1,
      usedToolCalls: 1,
      usedCostMinor: 150,
    });
    const usage = await restartedLedger.listUsage(tenantId, snapshot.scope.caseId);
    expect(usage).toHaveLength(2);
    expect(usage.map((row) => row.costCategory)).toEqual(["production_api", "rivet_runtime"]);
    expect(usage.every((row) => row.admitted === true)).toBe(true);
  });

  it("pauses new paid work at exhaustion but still admits reconciliation lookup attribution", async () => {
    const tenantId = `usage-exhaust-${randomUUID()}`;
    const snapshot = await createCaseFixture(store, tenantId, "case-usage-exhaust");
    await ledger.initializeAllowance({
      tenantId,
      caseId: snapshot.scope.caseId,
      maxModelCalls: 1,
      maxToolCalls: 0,
      maxCostMinor: 100,
      currency: "GBP",
    });
    await insertRunningJob(pool, {
      tenantId,
      caseId: snapshot.scope.caseId,
      taskId: "task-exhaust",
    });
    const base = {
      tenantId,
      relationshipId: snapshot.scope.relationshipId,
      caseId: snapshot.scope.caseId,
      taskId: "task-exhaust",
    };
    expect(
      (
        await ledger.reserveUsage({
          ...base,
          kind: "model_call",
          quantity: 1,
          costMinor: 90,
          currency: "GBP",
          metadata: { costCategory: "production_api" },
        })
      ).admitted,
    ).toBe(true);

    const denied = await ledger.reserveUsage({
      ...base,
      kind: "model_call",
      quantity: 1,
      costMinor: 5,
      currency: "GBP",
      metadata: { costCategory: "production_api", attempt: "must_not_run" },
    });
    expect(denied).toMatchObject({ admitted: false, reason: "budget_exhausted" });
    expect(denied.allowance).toMatchObject({
      status: "paused_budget",
      pauseReason: "budget_exhausted",
      usedModelCalls: 1,
      usedCostMinor: 90,
    });

    const deniedAgain = await ledger.reserveUsage({
      ...base,
      kind: "tool_call",
      quantity: 1,
      metadata: { costCategory: "production_api" },
    });
    expect(deniedAgain).toMatchObject({ admitted: false, reason: "budget_exhausted" });

    const reconciliation = await ledger.reserveUsage({
      ...base,
      taskId: null,
      kind: "reconciliation_lookup",
      quantity: 1,
      costMinor: 20,
      currency: "GBP",
      metadata: { costCategory: "human_operator", obligation: "unknown-handoff" },
    });
    expect(reconciliation.admitted).toBe(true);
    expect(reconciliation.allowance).toMatchObject({
      status: "paused_budget",
      usedModelCalls: 1,
      usedToolCalls: 0,
      usedCostMinor: 110,
    });

    const rows = await ledger.listUsage(tenantId, snapshot.scope.caseId);
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => [row.kind, row.admitted])).toEqual([
      ["model_call", true],
      ["model_call", false],
      ["tool_call", false],
      ["reconciliation_lookup", true],
    ]);
    expect(rows[3]?.metadata).toMatchObject({ obligation: "unknown-handoff" });
  });

  it("rejects a cost currency that does not match the case allowance", async () => {
    const tenantId = `usage-currency-${randomUUID()}`;
    const snapshot = await createCaseFixture(store, tenantId, "case-usage-currency");
    await ledger.initializeAllowance({
      tenantId,
      caseId: snapshot.scope.caseId,
      maxModelCalls: 2,
      maxToolCalls: 1,
      maxCostMinor: 500,
      currency: "HKD",
    });
    await expect(
      ledger.reserveUsage({
        tenantId,
        relationshipId: snapshot.scope.relationshipId,
        caseId: snapshot.scope.caseId,
        taskId: "task-currency",
        kind: "model_call",
        quantity: 1,
        costMinor: 100,
        currency: "USD",
        metadata: { costCategory: "production_api" },
      }),
    ).rejects.toMatchObject({ code: "invalid_usage_reservation" });
    expect(await ledger.getAllowance(tenantId, snapshot.scope.caseId)).toMatchObject({
      usedModelCalls: 0,
      usedCostMinor: 0,
      status: "active",
    });
    expect(await ledger.listUsage(tenantId, snapshot.scope.caseId)).toEqual([]);
  });

  it("closes one case allowance without closing the relationship or a follow-up allowance", async () => {
    const tenantId = `usage-close-${randomUUID()}`;
    const first = await createCaseFixture(store, tenantId, "case-usage-close-1");
    const second = await createCaseFixture(store, tenantId, "case-usage-close-2");
    await ledger.initializeAllowance({
      tenantId,
      caseId: first.scope.caseId,
      maxModelCalls: 1,
      maxToolCalls: 1,
      maxCostMinor: 100,
      currency: "GBP",
    });
    await ledger.closeAllowance(tenantId, first.scope.caseId);
    const denied = await ledger.reserveUsage({
      tenantId,
      relationshipId: first.scope.relationshipId,
      caseId: first.scope.caseId,
      kind: "reconciliation_lookup",
      quantity: 1,
      metadata: { costCategory: "human_operator" },
    });
    expect(denied).toMatchObject({ admitted: false, reason: "allowance_closed" });

    await ledger.initializeAllowance({
      tenantId,
      caseId: second.scope.caseId,
      maxModelCalls: 1,
      maxToolCalls: 1,
      maxCostMinor: 100,
      currency: "GBP",
    });
    await insertRunningJob(pool, {
      tenantId,
      caseId: second.scope.caseId,
      taskId: "task-followup",
    });
    const followup = await ledger.reserveUsage({
      tenantId,
      relationshipId: second.scope.relationshipId,
      caseId: second.scope.caseId,
      taskId: "task-followup",
      kind: "model_call",
      quantity: 1,
      metadata: { costCategory: "dev_subscription" },
    });
    expect(followup.admitted).toBe(true);
    const relationships = await pool.query(
      "SELECT id FROM customer_relationships WHERE tenant_id = $1",
      [tenantId],
    );
    expect(relationships.rows).toHaveLength(1);
  });

  it("enforces running per-task caps atomically without pausing the larger case budget", async () => {
    const tenantId = `usage-task-caps-${randomUUID()}`;
    const snapshot = await createCaseFixture(store, tenantId, "case-usage-task-caps");
    const caseId = snapshot.scope.caseId;
    await ledger.initializeAllowance({
      tenantId,
      caseId,
      maxModelCalls: 10,
      maxToolCalls: 10,
      maxCostMinor: null,
      currency: null,
    });
    await insertRunningJob(pool, {
      tenantId,
      caseId,
      taskId: "task-capped",
      maxModelCalls: 1,
      maxToolCalls: 0,
    });
    await insertRunningJob(pool, {
      tenantId,
      caseId,
      taskId: "task-independent",
      maxModelCalls: 2,
      maxToolCalls: 0,
    });
    const base = {
      tenantId,
      relationshipId: snapshot.scope.relationshipId,
      caseId,
    };

    const first = await ledger.reserveUsage({
      ...base,
      taskId: "task-capped",
      kind: "model_call",
      quantity: 1,
      metadata: { costCategory: "dev_subscription" },
    });
    expect(first.admitted).toBe(true);

    const restartedLedger = new PostgresUsageLedger(pool);
    const retry = await restartedLedger.reserveUsage({
      ...base,
      taskId: "task-capped",
      kind: "model_call",
      quantity: 1,
      metadata: { costCategory: "dev_subscription", attempt: "restart-retry" },
    });
    expect(retry).toMatchObject({ admitted: false, reason: "budget_exhausted" });
    expect(retry.allowance).toMatchObject({
      status: "active",
      usedModelCalls: 1,
      usedToolCalls: 0,
    });

    const tool = await restartedLedger.reserveUsage({
      ...base,
      taskId: "task-capped",
      kind: "tool_call",
      quantity: 1,
      metadata: { costCategory: "dev_subscription" },
    });
    expect(tool.admitted).toBe(false);

    const unauthorized = await restartedLedger.reserveUsage({
      ...base,
      taskId: "task-without-running-authority",
      kind: "model_call",
      quantity: 1,
      metadata: { costCategory: "dev_subscription" },
    });
    expect(unauthorized).toMatchObject({ admitted: false, reason: "budget_exhausted" });
    expect(unauthorized.allowance).toMatchObject({ status: "active", usedModelCalls: 1 });

    const independent = await restartedLedger.reserveUsage({
      ...base,
      taskId: "task-independent",
      kind: "model_call",
      quantity: 1,
      metadata: { costCategory: "dev_subscription" },
    });
    expect(independent.admitted).toBe(true);

    const race = await Promise.all([
      restartedLedger.reserveUsage({
        ...base,
        taskId: "task-independent",
        kind: "model_call",
        quantity: 1,
        metadata: { costCategory: "dev_subscription", attempt: "race-a" },
      }),
      new PostgresUsageLedger(pool).reserveUsage({
        ...base,
        taskId: "task-independent",
        kind: "model_call",
        quantity: 1,
        metadata: { costCategory: "dev_subscription", attempt: "race-b" },
      }),
    ]);
    expect(race.filter((result) => result.admitted)).toHaveLength(1);
    expect(race.filter((result) => !result.admitted)).toHaveLength(1);

    const caseOnly = await restartedLedger.reserveUsage({
      ...base,
      taskId: null,
      kind: "model_call",
      quantity: 1,
      metadata: { costCategory: "human_operator", reason: "operator-review" },
    });
    expect(caseOnly.admitted).toBe(true);
    expect(caseOnly.allowance).toMatchObject({
      status: "active",
      usedModelCalls: 4,
      usedToolCalls: 0,
      usedCostMinor: 0,
    });

    const rows = await restartedLedger.listUsage(tenantId, caseId);
    const cappedRows = rows.filter((row) => row.taskId === "task-capped");
    expect(cappedRows.map((row) => [row.kind, row.admitted])).toEqual([
      ["model_call", true],
      ["model_call", false],
      ["tool_call", false],
    ]);
    expect(cappedRows[1]?.metadata?.rejectionDetail).toBe("task_limit_exceeded");
    expect(cappedRows[2]?.metadata?.rejectionDetail).toBe("task_limit_exceeded");
    expect(
      rows.find((row) => row.taskId === "task-without-running-authority")?.metadata,
    ).toMatchObject({ admitted: false, rejectionDetail: "task_authority_inactive" });
    expect(
      rows.filter(
        (row) => row.taskId === "task-independent" && row.kind === "model_call" && row.admitted,
      ),
    ).toHaveLength(2);
  });
});
