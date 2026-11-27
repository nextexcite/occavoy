import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { demoEvents } from "@occavoy/domain";
import { applyMigrations, PostgresCaseStore, PostgresUsageLedger } from "@occavoy/storage";
import pg from "pg";
import {
  agentCandidateCommandId,
  defaultScriptedCandidate,
  MAX_DEADLINE_TIMER_DELAY_MS,
  PiJobAdapter,
  piActorKeyForJob,
  ScriptedCaseJobAdapter,
} from "../dist/case-job-adapter.js";
import { ServiceCaseCoordinator } from "../dist/service-case.js";

const DATABASE_URL = process.env.DATABASE_URL;
const dbTest = DATABASE_URL ? test : test.skip;
const NOW = new Date("2027-01-01T12:00:00Z");

function authority(tenantId, caseId, kind, actorId = "runtime-fixture") {
  const permission = {
    activate: "case.edit",
    cancel: "case.edit",
    revise_brief: "case.edit",
    agent_candidate: "agent.result",
    request_quote: "supply.request",
    close: "case.close",
  }[kind];
  return {
    tenantId,
    caseId,
    actorId,
    grantId: `grant-${actorId}`,
    permissions: [permission],
    validUntil: "2027-01-10T12:00:00Z",
  };
}

async function createFixture(store, tenantId, caseId) {
  const event = demoEvents[1];
  const snapshot = await store.createCase({
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
  return { event, snapshot };
}

function command(caseRow, body, commandId, expectedRevision) {
  return {
    ...body,
    commandId,
    tenantId: caseRow.scope.tenantId,
    caseId: caseRow.scope.caseId,
    expectedRevision,
  };
}

function makeCoordinator({
  store,
  usageLedger,
  runnerScript,
  supplierRequests,
  cancelCalls,
  staleDispatchMs = 120000,
  requestSupplierQuote,
}) {
  return new ServiceCaseCoordinator({
    store,
    usageLedger,
    staleDispatchMs,
    now: () => NOW,
    allowanceForTask: (task) => ({
      maxModelCalls: task.maxModelCalls,
      maxToolCalls: task.maxToolCalls,
      maxCostMinor: 1000,
      currency: "GBP",
    }),
    createJobAdapter: (spec) =>
      new ScriptedCaseJobAdapter(
        {
          store,
          usageLedger,
          relationshipIdForJob: async () =>
            (await store.getCase(spec.tenantId, spec.caseId)).scope.relationshipId,
          authorityForJob: (job) => authority(job.tenantId, job.caseId, "agent_candidate"),
          now: () => NOW,
        },
        runnerScript,
      ),
    requestSupplierQuote:
      requestSupplierQuote ??
      (async (rfq) => {
        if (!supplierRequests.some((id) => id === rfq.id)) supplierRequests.push(rfq.id);
      }),
    cancelAgentTask: async (task) => {
      cancelCalls.push(task.taskId);
    },
  });
}

async function activateAndDrain(coordinator, snapshot, taskId) {
  const activateBody = {
    kind: "activate",
    taskId,
    maxModelCalls: 2,
    maxToolCalls: 2,
  };
  const result = await coordinator.submitCommand(
    command(snapshot, activateBody, `${taskId}-activate`, snapshot.revision),
    authority(snapshot.scope.tenantId, snapshot.scope.caseId, "activate"),
  );
  assert.equal(result.decision.outcome, "applied");
  const drain = await coordinator.drainCase(snapshot.scope.tenantId, snapshot.scope.caseId);
  assert.equal(drain.completed, 1);
  return result;
}

test("job adapter does not start an expired job or admit paid work", async () => {
  let invocations = 0;
  const spec = {
    tenantId: "tenant-deadline",
    caseId: "case-deadline",
    taskId: "task-deadline",
    requestId: "task-deadline",
    baseRevision: 1,
    briefVersion: 1,
    purpose: "derive_requirements",
    toolProfile: "case_readonly_v1",
    deadlineAt: "2020-01-01T00:00:00Z",
    maxModelCalls: 1,
    maxToolCalls: 0,
  };
  const adapter = new PiJobAdapter(
    {
      store: null,
      usageLedger: null,
      relationshipIdForJob: async () => "relationship-deadline",
      authorityForJob: () => authority(spec.tenantId, spec.caseId, "agent_candidate"),
    },
    async () => {
      invocations += 1;
      return null;
    },
  );
  assert.deepEqual(await adapter.run(spec), { status: "aborted", reason: "deadline_exceeded" });
  assert.equal(invocations, 0);
});

function jobSpec(overrides = {}) {
  return {
    tenantId: "tenant-job",
    caseId: "case-job",
    taskId: "task-job",
    requestId: "task-job",
    baseRevision: 1,
    briefVersion: 1,
    purpose: "derive_requirements",
    toolProfile: "case_readonly_v1",
    deadlineAt: "2027-01-01T12:00:10.000Z",
    maxModelCalls: 1,
    maxToolCalls: 0,
    ...overrides,
  };
}

function mockClock(startMs = NOW.getTime()) {
  let now = startMs;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => new Date(now),
    scheduleTimeout: (callback, delayMs) => {
      const handle = { id: nextId++ };
      timers.set(handle, { callback, delayMs, due: now + delayMs, cancelled: false });
      return handle;
    },
    cancelTimeout: (handle) => {
      const timer = timers.get(handle);
      if (timer) timer.cancelled = true;
    },
    advance: (durationMs) => {
      now += durationMs;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => !timer.cancelled && timer.due <= now)
          .sort((left, right) => left[1].due - right[1].due)[0];
        if (!due) return;
        const [handle, timer] = due;
        timers.delete(handle);
        timer.callback();
      }
    },
    activeDelays: () =>
      [...timers.values()].filter((timer) => !timer.cancelled).map((timer) => timer.delayMs),
  };
}

function adapterTestHarness({ clock, reserveUsage, script } = {}) {
  const submissions = [];
  const adapter = new ScriptedCaseJobAdapter(
    {
      store: {
        submitCommand: async (command) => {
          submissions.push(command);
          return {
            deduplicated: false,
            decision: { outcome: "applied", reason: "agent_candidate", state: null, intents: [] },
          };
        },
      },
      usageLedger: {
        reserveUsage:
          reserveUsage ??
          (async () => ({
            admitted: true,
            allowance: {},
          })),
      },
      relationshipIdForJob: async () => "relationship-job",
      authorityForJob: (spec) => authority(spec.tenantId, spec.caseId, "agent_candidate"),
      now: clock?.now ?? (() => NOW),
      ...(clock
        ? { scheduleTimeout: clock.scheduleTimeout, cancelTimeout: clock.cancelTimeout }
        : {}),
    },
    script,
  );
  return { adapter, submissions };
}

test("agent candidate command identity is stable, namespaced, and case scoped", async () => {
  const spec = jobSpec();
  const retry = agentCandidateCommandId(spec);
  assert.equal(retry, agentCandidateCommandId({ ...spec }));
  assert.match(retry, /^occavoy-agent-candidate-v1-[0-9a-f]{64}$/);
  assert.notEqual(retry, agentCandidateCommandId({ ...spec, caseId: "case-other" }));
  assert.notEqual(retry, agentCandidateCommandId({ ...spec, requestId: "request-other" }));
  const { adapter, submissions } = adapterTestHarness({
    script: { modelSteps: [], result: defaultScriptedCandidate },
  });
  const submitted = await adapter.run(spec);
  assert.equal(submitted.status, "submitted");
  assert.equal(submissions[0].commandId, retry);
});

test("deadline timer caps and rearms long delays until the real deadline", async () => {
  const startMs = NOW.getTime();
  const remainderMs = 1234;
  const deadlineMs = startMs + MAX_DEADLINE_TIMER_DELAY_MS * 2 + remainderMs;
  const clock = mockClock(startMs);
  let abortObserved = false;
  const { adapter } = adapterTestHarness({
    clock,
    script: async (_spec, controls) => {
      await new Promise((_resolve, reject) => {
        controls.signal.addEventListener(
          "abort",
          () => {
            abortObserved = true;
            reject(new Error("deadline stopped the job"));
          },
          { once: true },
        );
      });
      return null;
    },
  });
  const running = adapter.run(jobSpec({ deadlineAt: new Date(deadlineMs).toISOString() }));
  assert.deepEqual(clock.activeDelays(), [MAX_DEADLINE_TIMER_DELAY_MS]);
  clock.advance(MAX_DEADLINE_TIMER_DELAY_MS);
  assert.deepEqual(clock.activeDelays(), [MAX_DEADLINE_TIMER_DELAY_MS]);
  clock.advance(MAX_DEADLINE_TIMER_DELAY_MS);
  assert.deepEqual(clock.activeDelays(), [remainderMs]);
  clock.advance(remainderMs);
  assert.deepEqual(await running, { status: "aborted", reason: "deadline_exceeded" });
  assert.equal(abortObserved, true);
  assert.deepEqual(clock.activeDelays(), []);
});

test("caller cancellation is preserved and cleans up a rearmed deadline timer", async () => {
  const clock = mockClock(NOW.getTime());
  const caller = new AbortController();
  const { adapter } = adapterTestHarness({
    clock,
    script: async (_spec, controls) => {
      await new Promise((_resolve, reject) => {
        controls.signal.addEventListener("abort", () => reject(new Error("caller cancelled")), {
          once: true,
        });
      });
      return null;
    },
  });
  const running = adapter.run(jobSpec(), { signal: caller.signal });
  assert.equal(clock.activeDelays().length, 1);
  caller.abort();
  assert.deepEqual(await running, { status: "aborted", reason: "cancelled" });
  assert.deepEqual(clock.activeDelays(), []);
});

test("deadline is rechecked after reservation before provider work may continue", async () => {
  const startMs = NOW.getTime();
  const deadlineMs = startMs + 100;
  const clock = mockClock(startMs);
  let providerWork = false;
  const { adapter, submissions } = adapterTestHarness({
    clock,
    reserveUsage: async () => {
      clock.advance(150);
      return { admitted: true, allowance: {} };
    },
    script: async (spec, controls) => {
      await controls.reserveModelCall();
      providerWork = true;
      return defaultScriptedCandidate(spec);
    },
  });
  const result = await adapter.run(jobSpec({ deadlineAt: new Date(deadlineMs).toISOString() }));
  assert.deepEqual(result, { status: "aborted", reason: "deadline_exceeded" });
  assert.equal(providerWork, false);
  assert.equal(submissions.length, 0);
});

dbTest(
  "service case waits for supplier without model work and recovers without duplicates",
  async (t) => {
    const pool = new pg.Pool({ connectionString: DATABASE_URL });
    await applyMigrations(pool);
    const store = new PostgresCaseStore(pool);
    const usageLedger = new PostgresUsageLedger(pool);
    const tenantId = `service-recover-${randomUUID()}`;
    const caseId = "case-service-recover";
    const { snapshot } = await createFixture(store, tenantId, caseId);
    const supplierRequests = [];
    const cancelCalls = [];
    let runnerStarts = 0;
    const script = async (spec, controls) => {
      runnerStarts += 1;
      await controls.reserveModelCall({ costMinor: 10, currency: "GBP" });
      return defaultScriptedCandidate(spec);
    };
    const coordinator = makeCoordinator({
      store,
      usageLedger,
      runnerScript: script,
      supplierRequests,
      cancelCalls,
    });
    await usageLedger.initializeAllowance({
      tenantId,
      caseId,
      maxModelCalls: 2,
      maxToolCalls: 2,
      maxCostMinor: 777,
      currency: "GBP",
    });
    const activation = await activateAndDrain(coordinator, snapshot, "task-recover");
    assert.equal(runnerStarts, 1);
    assert.equal((await usageLedger.getAllowance(tenantId, caseId)).maxCostMinor, 777);
    let state = await store.getCase(tenantId, caseId);
    assert.equal(state.phase, "sourcing");
    assert.equal(state.activeTask, null);

    const quoteBody = {
      kind: "request_quote",
      rfq: {
        id: `rfq-${caseId}`,
        supplierId: "supplier-fixture",
        briefVersion: 1,
        requirementIds: [`requirement-task-recover`],
      },
    };
    const quoteCommand = command(snapshot, quoteBody, `${caseId}-request-quote`, state.revision);
    const quoteResult = await coordinator.submitCommand(
      quoteCommand,
      authority(tenantId, caseId, "request_quote", "operator-fixture"),
    );
    assert.equal(quoteResult.decision.outcome, "applied");
    state = quoteResult.decision.state;
    assert.equal(state.waitReason, "supplier_quote");
    assert.equal(state.activeTask, null);
    assert.equal(runnerStarts, 1, "supplier wait must not keep or start model work");

    // Simulate a process loss after the database claim but before dispatch completion.
    const claimed = await store.claimPendingOutbox(10, { tenantId, caseId });
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].intentKind, "request_supplier_quote");

    // A replacement coordinator recovers the same Postgres state and requeues the stale claim.
    const replacement = makeCoordinator({
      store,
      usageLedger,
      runnerScript: script,
      supplierRequests,
      cancelCalls,
      staleDispatchMs: -1000,
    });
    const recovered = await replacement.recoverCase(tenantId, caseId);
    assert.equal(recovered.state.revision, state.revision);
    assert.equal(recovered.state.waitReason, "supplier_quote");
    assert.equal(recovered.drain.claimed, 1);
    assert.deepEqual(supplierRequests, [`rfq-${caseId}`]);
    assert.equal(runnerStarts, 1);

    // Exact duplicate delivery returns the original decision and creates zero new effects.
    const duplicate = await replacement.submitCommand(
      quoteCommand,
      authority(tenantId, caseId, "request_quote", "operator-fixture"),
    );
    assert.equal(duplicate.deduplicated, true);
    assert.equal(duplicate.decision.reason, quoteResult.decision.reason);
    await replacement.drainCase(tenantId, caseId);
    assert.deepEqual(supplierRequests, [`rfq-${caseId}`]);
    assert.equal(runnerStarts, 1);
    const outbox = await store.listOutboxForCase(tenantId, caseId);
    assert.equal(outbox.filter((row) => row.intentKind === "request_supplier_quote").length, 1);

    // Replaying activation by its original command ID is also a receipt-level duplicate.
    const activationCommand = (await store.getCommand(tenantId, "task-recover-activate")).command;
    const activationDuplicate = await replacement.submitCommand(
      activationCommand,
      authority(tenantId, caseId, "activate"),
    );
    assert.equal(activationDuplicate.deduplicated, true);
    assert.equal(runnerStarts, 1);
    assert.equal(activation.decision.state.revision, 1);

    t.after(() => pool.end());
  },
);

dbTest(
  "a supplier RFQ cancelled before drain completes as stale without an external send",
  async (t) => {
    const pool = new pg.Pool({ connectionString: DATABASE_URL });
    await applyMigrations(pool);
    const store = new PostgresCaseStore(pool);
    const usageLedger = new PostgresUsageLedger(pool);
    const tenantId = `service-rfq-cancel-${randomUUID()}`;
    const caseId = "case-service-rfq-cancel";
    const { snapshot } = await createFixture(store, tenantId, caseId);
    const supplierRequests = [];
    const cancelCalls = [];
    const coordinator = makeCoordinator({
      store,
      usageLedger,
      supplierRequests,
      cancelCalls,
    });
    await activateAndDrain(coordinator, snapshot, "task-rfq-cancel");
    const sourcing = await store.getCase(tenantId, caseId);
    const quoteResult = await coordinator.submitCommand(
      command(
        snapshot,
        {
          kind: "request_quote",
          rfq: {
            id: `rfq-${caseId}`,
            supplierId: "supplier-fixture",
            briefVersion: 1,
            requirementIds: ["requirement-task-rfq-cancel"],
          },
        },
        `${caseId}-request-quote`,
        sourcing.revision,
      ),
      authority(tenantId, caseId, "request_quote", "operator-fixture"),
    );
    assert.equal(quoteResult.decision.outcome, "applied");
    const cancelResult = await coordinator.submitCommand(
      command(
        snapshot,
        { kind: "cancel", reason: "customer cancelled before supplier dispatch" },
        `${caseId}-cancel-before-quote-drain`,
        quoteResult.decision.state.revision,
      ),
      authority(tenantId, caseId, "cancel"),
    );
    assert.equal(cancelResult.decision.outcome, "applied");

    const drain = await coordinator.drainCase(tenantId, caseId);
    assert.equal(drain.claimed, 1);
    assert.equal(drain.completed, 1);
    assert.equal(drain.errors.length, 0);
    assert.deepEqual(supplierRequests, []);
    const outbox = await store.listOutboxForCase(tenantId, caseId);
    assert.equal(outbox[0].status, "completed");

    t.after(() => pool.end());
  },
);

dbTest("a retried supplier RFQ is fenced again after a brief revision", async (t) => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  await applyMigrations(pool);
  const store = new PostgresCaseStore(pool);
  const usageLedger = new PostgresUsageLedger(pool);
  const tenantId = `service-rfq-revise-${randomUUID()}`;
  const caseId = "case-service-rfq-revise";
  const { event, snapshot } = await createFixture(store, tenantId, caseId);
  const supplierAttempts = [];
  const cancelCalls = [];
  const coordinator = makeCoordinator({
    store,
    usageLedger,
    supplierRequests: [],
    cancelCalls,
    requestSupplierQuote: async (rfq) => {
      supplierAttempts.push(rfq.id);
      throw new Error("synthetic supplier send failure");
    },
  });
  await activateAndDrain(coordinator, snapshot, "task-rfq-revise");
  const sourcing = await store.getCase(tenantId, caseId);
  const quoteResult = await coordinator.submitCommand(
    command(
      snapshot,
      {
        kind: "request_quote",
        rfq: {
          id: `rfq-${caseId}`,
          supplierId: "supplier-fixture",
          briefVersion: 1,
          requirementIds: ["requirement-task-rfq-revise"],
        },
      },
      `${caseId}-request-quote`,
      sourcing.revision,
    ),
    authority(tenantId, caseId, "request_quote", "operator-fixture"),
  );
  assert.equal(quoteResult.decision.outcome, "applied");

  const failed = await coordinator.drainCase(tenantId, caseId);
  assert.equal(failed.claimed, 1);
  assert.equal(failed.requeued, 1);
  assert.equal(failed.errors.length, 1);
  assert.deepEqual(supplierAttempts, [`rfq-${caseId}`]);
  await pool.query(
    `UPDATE case_outbox SET available_at = now() - interval '1 second'
     WHERE tenant_id = $1 AND case_id = $2 AND status = 'pending'`,
    [tenantId, caseId],
  );
  const revisedBrief = {
    id: snapshot.brief.id,
    version: 2,
    eventId: event.id,
    destination: event.destination,
    budget: { amountMinor: 110000, currency: "GBP" },
    approverActorId: "payer-fixture",
  };
  const revision = await coordinator.submitCommand(
    command(
      snapshot,
      { kind: "revise_brief", brief: revisedBrief },
      `${caseId}-revise-before-retry`,
      quoteResult.decision.state.revision,
    ),
    authority(tenantId, caseId, "revise_brief"),
  );
  assert.equal(revision.decision.outcome, "applied");

  const retryDrain = await coordinator.drainCase(tenantId, caseId);
  assert.equal(retryDrain.claimed, 1);
  assert.equal(retryDrain.completed, 1);
  assert.equal(retryDrain.errors.length, 0);
  assert.deepEqual(supplierAttempts, [`rfq-${caseId}`]);
  const outbox = await store.listOutboxForCase(tenantId, caseId);
  assert.equal(outbox[0].status, "completed");

  t.after(() => pool.end());
});

dbTest(
  "cancel while a job runs aborts it, meters the attempt, and fences a late candidate",
  async (t) => {
    const pool = new pg.Pool({ connectionString: DATABASE_URL });
    await applyMigrations(pool);
    const store = new PostgresCaseStore(pool);
    const usageLedger = new PostgresUsageLedger(pool);
    const tenantId = `service-cancel-${randomUUID()}`;
    const caseId = "case-service-cancel";
    const { snapshot } = await createFixture(store, tenantId, caseId);
    const supplierRequests = [];
    const cancelCalls = [];
    let started;
    const startedPromise = new Promise((resolve) => {
      started = resolve;
    });
    const script = async (spec, controls) => {
      await controls.reserveModelCall({ costMinor: 10, currency: "GBP" });
      started();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5000);
        controls.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("cancelled while model work was in flight"));
          },
          { once: true },
        );
      });
      return defaultScriptedCandidate(spec);
    };
    const coordinator = makeCoordinator({
      store,
      usageLedger,
      runnerScript: script,
      supplierRequests,
      cancelCalls,
    });
    const activateBody = {
      kind: "activate",
      taskId: "task-cancel",
      maxModelCalls: 2,
      maxToolCalls: 2,
    };
    await coordinator.submitCommand(
      command(snapshot, activateBody, "task-cancel-activate", 0),
      authority(tenantId, caseId, "activate"),
    );
    const drainPromise = coordinator.drainCase(tenantId, caseId);
    await startedPromise;
    const cancelResult = await coordinator.submitCommand(
      command(snapshot, { kind: "cancel", reason: "customer cancelled" }, "cancel-running", 1),
      authority(tenantId, caseId, "cancel"),
    );
    assert.equal(cancelResult.decision.outcome, "applied");
    const drain = await drainPromise;
    assert.equal(drain.errors.length, 0);
    await coordinator.drainCase(tenantId, caseId);
    assert.deepEqual(cancelCalls, ["task-cancel"]);
    const closed = await store.getCase(tenantId, caseId);
    assert.equal(closed.phase, "closed");
    assert.equal(closed.outcome, "cancelled");
    const allowance = await usageLedger.getAllowance(tenantId, caseId);
    assert.equal(allowance.usedModelCalls, 1, "the interrupted call remains metered");
    assert.equal(allowance.status, "closed");

    // If a harness process nevertheless returns later, its exact job fence is ignored by Postgres.
    const jobSpec = {
      tenantId,
      caseId,
      taskId: "task-cancel",
      requestId: "task-cancel",
      baseRevision: 1,
      briefVersion: 1,
      purpose: "derive_requirements",
      toolProfile: "case_readonly_v1",
      deadlineAt: "2027-01-10T12:00:00Z",
      maxModelCalls: 2,
      maxToolCalls: 2,
    };
    assert.deepEqual(piActorKeyForJob(jobSpec), [tenantId, caseId, "task-cancel"]);
    const lateAdapter = new PiJobAdapter(
      {
        store,
        usageLedger,
        relationshipIdForJob: async () =>
          (await store.getCase(tenantId, caseId)).scope.relationshipId,
        authorityForJob: (job) => authority(job.tenantId, job.caseId, "agent_candidate"),
        now: () => NOW,
      },
      async (invocation) => {
        assert.deepEqual(invocation.key, [tenantId, caseId, "task-cancel"]);
        return defaultScriptedCandidate(jobSpec);
      },
    );
    const late = await lateAdapter.run(jobSpec);
    assert.equal(late.status, "submitted");
    assert.equal(late.decision.outcome, "ignored");
    assert.equal(late.decision.reason, "stale_case_revision");
    const candidateCommands = await pool.query(
      "SELECT outcome, reason FROM case_commands WHERE tenant_id = $1 AND command_kind = 'agent_candidate'",
      [tenantId],
    );
    assert.equal(candidateCommands.rows.length, 1);
    assert.equal(candidateCommands.rows[0].outcome, "ignored");

    t.after(() => pool.end());
  },
);

dbTest(
  "a duplicate historical activation receipt does not abort the replacement job",
  async (t) => {
    const pool = new pg.Pool({ connectionString: DATABASE_URL });
    await applyMigrations(pool);
    const store = new PostgresCaseStore(pool);
    const usageLedger = new PostgresUsageLedger(pool);
    const tenantId = `service-duplicate-${randomUUID()}`;
    const caseId = "case-service-duplicate";
    const { event, snapshot } = await createFixture(store, tenantId, caseId);
    const supplierRequests = [];
    const cancelCalls = [];
    let releaseReplacement;
    let replacementStarted;
    const replacementGate = new Promise((resolve) => {
      releaseReplacement = resolve;
    });
    const replacementStartedPromise = new Promise((resolve) => {
      replacementStarted = resolve;
    });
    const script = async (spec, controls) => {
      await controls.reserveModelCall();
      if (spec.taskId === "task-new") {
        replacementStarted();
        await Promise.race([
          replacementGate,
          new Promise((resolve, reject) => {
            controls.signal.addEventListener(
              "abort",
              () => reject(new Error("replacement was incorrectly aborted")),
              { once: true },
            );
          }),
        ]);
      }
      return defaultScriptedCandidate(spec);
    };
    const coordinator = makeCoordinator({
      store,
      usageLedger,
      runnerScript: script,
      supplierRequests,
      cancelCalls,
    });
    await activateAndDrain(coordinator, snapshot, "task-old");
    let current = await store.getCase(tenantId, caseId);
    const revisedBrief = {
      id: snapshot.brief.id,
      version: 2,
      eventId: event.id,
      destination: event.destination,
      budget: { amountMinor: 120000, currency: "GBP" },
      approverActorId: "payer-fixture",
    };
    const revision = await coordinator.submitCommand(
      command(
        snapshot,
        { kind: "revise_brief", brief: revisedBrief },
        "revise-complete",
        current.revision,
      ),
      authority(tenantId, caseId, "revise_brief"),
    );
    assert.equal(revision.decision.outcome, "applied");
    current = revision.decision.state;
    const replacementActivation = await coordinator.submitCommand(
      command(
        snapshot,
        { kind: "activate", taskId: "task-new", maxModelCalls: 2, maxToolCalls: 1 },
        "task-new-activate",
        current.revision,
      ),
      authority(tenantId, caseId, "activate"),
    );
    assert.equal(replacementActivation.decision.outcome, "applied");
    const drainPromise = coordinator.drainCase(tenantId, caseId);
    await replacementStartedPromise;

    const historical = (await store.getCommand(tenantId, "task-old-activate")).command;
    const duplicate = await coordinator.submitCommand(
      historical,
      authority(tenantId, caseId, "activate"),
    );
    assert.equal(duplicate.deduplicated, true);
    releaseReplacement();
    const drain = await drainPromise;
    assert.equal(drain.errors.length, 0);
    const finished = await store.getCase(tenantId, caseId);
    assert.equal(finished.activeTask, null);
    assert.equal(finished.brief.version, 2);

    t.after(() => pool.end());
  },
);

dbTest("a task cancelled before its delayed dispatch never starts paid work", async (t) => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  await applyMigrations(pool);
  const store = new PostgresCaseStore(pool);
  const usageLedger = new PostgresUsageLedger(pool);
  const tenantId = `service-predrain-cancel-${randomUUID()}`;
  const caseId = "case-service-predrain-cancel";
  const { snapshot } = await createFixture(store, tenantId, caseId);
  const supplierRequests = [];
  const cancelCalls = [];
  let runnerStarts = 0;
  const coordinator = makeCoordinator({
    store,
    usageLedger,
    runnerScript: async (spec, controls) => {
      runnerStarts += 1;
      await controls.reserveModelCall({ costMinor: 10, currency: "GBP" });
      return defaultScriptedCandidate(spec);
    },
    supplierRequests,
    cancelCalls,
  });
  await coordinator.submitCommand(
    command(
      snapshot,
      { kind: "activate", taskId: "task-predrain", maxModelCalls: 1, maxToolCalls: 0 },
      "task-predrain-activate",
      0,
    ),
    authority(tenantId, caseId, "activate"),
  );
  await coordinator.submitCommand(
    command(snapshot, { kind: "cancel", reason: "changed mind" }, "cancel-before-drain", 1),
    authority(tenantId, caseId, "cancel"),
  );

  const drain = await coordinator.drainCase(tenantId, caseId);
  assert.equal(drain.completed, 2);
  assert.equal(drain.errors.length, 0);
  assert.equal(runnerStarts, 0);
  assert.deepEqual(cancelCalls, ["task-predrain"]);
  assert.equal((await usageLedger.listUsage(tenantId, caseId)).length, 0);

  t.after(() => pool.end());
});

dbTest(
  "brief revision aborts in-flight work and a stale candidate cannot replace the new brief",
  async (t) => {
    const pool = new pg.Pool({ connectionString: DATABASE_URL });
    await applyMigrations(pool);
    const store = new PostgresCaseStore(pool);
    const usageLedger = new PostgresUsageLedger(pool);
    const tenantId = `service-revise-${randomUUID()}`;
    const caseId = "case-service-revise";
    const { event, snapshot } = await createFixture(store, tenantId, caseId);
    const supplierRequests = [];
    const cancelCalls = [];
    let started;
    const startedPromise = new Promise((resolve) => {
      started = resolve;
    });
    const script = async (spec, controls) => {
      await controls.reserveModelCall();
      started();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5000);
        controls.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("revision superseded job"));
          },
          { once: true },
        );
      });
      return defaultScriptedCandidate(spec);
    };
    const coordinator = makeCoordinator({
      store,
      usageLedger,
      runnerScript: script,
      supplierRequests,
      cancelCalls,
    });
    await coordinator.submitCommand(
      command(
        snapshot,
        { kind: "activate", taskId: "task-revise", maxModelCalls: 2, maxToolCalls: 1 },
        "task-revise-activate",
        0,
      ),
      authority(tenantId, caseId, "activate"),
    );
    const drainPromise = coordinator.drainCase(tenantId, caseId);
    await startedPromise;
    const revisedBrief = {
      id: snapshot.brief.id,
      version: 2,
      eventId: event.id,
      destination: event.destination,
      budget: { amountMinor: 120000, currency: "GBP" },
      approverActorId: "payer-fixture",
    };
    const revision = await coordinator.submitCommand(
      command(snapshot, { kind: "revise_brief", brief: revisedBrief }, "revise-running", 1),
      authority(tenantId, caseId, "revise_brief"),
    );
    assert.equal(revision.decision.outcome, "applied");
    await drainPromise;
    const current = await store.getCase(tenantId, caseId);
    assert.equal(current.brief.version, 2);
    assert.equal(current.activeTask, null);

    const lateSpec = {
      tenantId,
      caseId,
      taskId: "task-revise",
      requestId: "task-revise",
      baseRevision: 1,
      briefVersion: 1,
      purpose: "derive_requirements",
      toolProfile: "case_readonly_v1",
      deadlineAt: "2027-01-10T12:00:00Z",
      maxModelCalls: 2,
      maxToolCalls: 1,
    };
    const lateAdapter = new ScriptedCaseJobAdapter(
      {
        store,
        usageLedger,
        relationshipIdForJob: async () =>
          (await store.getCase(tenantId, caseId)).scope.relationshipId,
        authorityForJob: (job) => authority(job.tenantId, job.caseId, "agent_candidate"),
        now: () => NOW,
      },
      { modelSteps: [] },
    );
    const late = await lateAdapter.run(lateSpec, { signal: new AbortController().signal });
    assert.equal(late.status, "submitted");
    assert.equal(late.decision.outcome, "ignored");
    assert.equal(late.decision.reason, "stale_case_revision");
    assert.equal((await store.getCase(tenantId, caseId)).brief.version, 2);

    t.after(() => pool.end());
  },
);

dbTest(
  "closing a case closes only that allowance; the relationship gets a fresh follow-up case",
  async (t) => {
    const pool = new pg.Pool({ connectionString: DATABASE_URL });
    await applyMigrations(pool);
    const store = new PostgresCaseStore(pool);
    const usageLedger = new PostgresUsageLedger(pool);
    const tenantId = `service-close-${randomUUID()}`;
    const caseId = "case-service-close";
    const { event, snapshot } = await createFixture(store, tenantId, caseId);
    const supplierRequests = [];
    const cancelCalls = [];
    const coordinator = makeCoordinator({
      store,
      usageLedger,
      supplierRequests,
      cancelCalls,
    });
    await activateAndDrain(coordinator, snapshot, "task-close");
    const state = await store.getCase(tenantId, caseId);
    const closed = await coordinator.submitCommand(
      command(snapshot, { kind: "close", outcome: "declined" }, "close-case", state.revision),
      authority(tenantId, caseId, "close", "operator-fixture"),
    );
    assert.equal(closed.decision.outcome, "applied");
    assert.equal((await usageLedger.getAllowance(tenantId, caseId)).status, "closed");

    const followupId = "case-service-followup";
    const followup = await store.createCase({
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
        budget: { amountMinor: 90000, currency: "GBP" },
        approverActorId: "payer-fixture",
      },
      deadline: "2027-02-01T12:00:00Z",
    });
    await usageLedger.initializeAllowance({
      tenantId,
      caseId: followup.scope.caseId,
      maxModelCalls: 1,
      maxToolCalls: 1,
      maxCostMinor: 100,
      currency: "GBP",
    });
    await pool.query(
      `INSERT INTO case_agent_jobs
        (tenant_id, case_id, task_id, request_id, brief_version, case_revision,
         max_model_calls, max_tool_calls, deadline, status)
       VALUES ($1, $2, 'task-followup', 'request-followup-task', 1, 1, 1, 1,
               '2027-02-01T12:00:00Z', 'running')`,
      [tenantId, followup.scope.caseId],
    );
    const fresh = await usageLedger.reserveUsage({
      tenantId,
      relationshipId: followup.scope.relationshipId,
      caseId: followup.scope.caseId,
      taskId: "task-followup",
      kind: "model_call",
      quantity: 1,
      metadata: { costCategory: "dev_subscription" },
    });
    assert.equal(fresh.admitted, true);
    const relationships = await pool.query(
      "SELECT id FROM customer_relationships WHERE tenant_id = $1",
      [tenantId],
    );
    assert.equal(relationships.rows.length, 1);

    t.after(() => pool.end());
  },
);
