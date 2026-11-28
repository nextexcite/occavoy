import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { demoEvents } from "@occavoy/domain";
import {
  applyMigrations,
  canonicalJson,
  PostgresCaseStore,
  PostgresUsageLedger,
} from "@occavoy/storage";
import { DeterministicEffectDispatcher } from "@occavoy/storage/effect-dispatcher";
import { FakeSupplierAdapter } from "@occavoy/storage/fake-supplier";
import pg from "pg";
import { testDatabaseUrl } from "../../../packages/storage/test/support/disposable-postgres.ts";
import { createCaseIntakeHandler } from "../../web/src/server/case-intake.ts";
import { defaultScriptedCandidate, ScriptedCaseJobAdapter } from "../dist/case-job-adapter.js";
import { ServiceCaseCoordinator } from "../dist/service-case.js";

const DATABASE_URL = testDatabaseUrl();
const dbTest = DATABASE_URL ? test : test.skip;

// Real-database integration test: deadline/grant validity use real local time.
const fixtureDeadline = () => new Date(Date.now() + 7 * 86_400_000).toISOString();

dbTest("local case trace: HTTP intake through durable journey", async (t) => {
  const schema = `trace_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: DATABASE_URL });
  const pool = new pg.Pool({
    connectionString: DATABASE_URL,
    options: `-c search_path=${schema}`,
  });
  const server = createServer();
  let schemaCreated = false;
  t.after(async () => {
    try {
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      if (schemaCreated) {
        const drop = await admin.query("SELECT format('DROP SCHEMA %I CASCADE', $1::text) AS ddl", [
          schema,
        ]);
        await admin.query(drop.rows[0].ddl);
      }
    } finally {
      await pool.end().catch(() => {});
      await admin.end().catch(() => {});
    }
  });
  await admin.query(`CREATE SCHEMA ${schema}`);
  schemaCreated = true;
  await applyMigrations(pool);
  const store = new PostgresCaseStore(pool);
  const usageLedger = new PostgresUsageLedger(pool);

  const deadline = fixtureDeadline();
  const tenant1 = `trace-${randomUUID()}`;
  const tenant2 = `trace-${randomUUID()}`;
  const caseId = "case-london-1";
  const grants = new Map();
  function grantFixture(tenantId, grantCaseId, relationship) {
    return {
      authority: {
        tenantId,
        caseId: grantCaseId,
        actorId: "customer-fixture",
        grantId: `grant-intake-${randomUUID()}`,
        permissions: ["case.edit"],
        validUntil: deadline,
      },
      relationship: relationship ?? {
        id: `relationship-${tenantId}`,
        tenantId,
        customerId: `customer-${tenantId}`,
        preferenceReuseAllowed: true,
      },
      approverActorId: "payer-fixture",
      deadline,
    };
  }
  const grant1 = grantFixture(tenant1, caseId);
  const token1 = randomUUID();
  grants.set(`Bearer ${token1}`, grant1);
  const token2 = randomUUID();
  grants.set(`Bearer ${token2}`, grantFixture(tenant2, caseId));

  const handler = createCaseIntakeHandler({
    resolveGrant: async (authorization) => grants.get(authorization) ?? null,
    findEvent: (id) => demoEvents.find((event) => event.id === id),
    store,
    now: () => new Date(),
  });

  server.on("request", async (req, res) => {
    try {
      const request = new Request(new URL(req.url, "http://127.0.0.1"), {
        method: req.method,
        headers: req.headers,
        ...(req.method === "POST" ? { body: req, duplex: "half" } : {}),
      });
      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  function post(body, token) {
    return fetch(`${base}/api/cases`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }
  const commandId1 = `intake-${randomUUID()}`;
  const validBody = {
    activate: true,
    commandId: commandId1,
    eventId: "fixture-london",
    budget: { amountMinor: 100000, currency: "GBP" },
  };

  assert.equal((await post(validBody)).status, 401);
  assert.equal((await post({ ...validBody, activate: false }, token1)).status, 400);
  assert.equal((await post({ ...validBody, tenantId: "spoof" }, token1)).status, 400);
  assert.equal((await post("{not json", token1)).status, 400);
  assert.equal((await post(`${JSON.stringify(validBody)}${"x".repeat(4096)}`, token1)).status, 413);
  const empty = await pool.query(
    "SELECT count(*)::int AS n FROM service_cases WHERE tenant_id = $1",
    [tenant1],
  );
  assert.equal(empty.rows[0].n, 0);

  const created = await post(validBody, token1);
  assert.equal(created.status, 202);
  const receipt = await created.json();
  assert.deepEqual(receipt, {
    commandId: commandId1,
    caseId,
    revision: 1,
    briefVersion: 1,
    deduplicated: false,
  });
  assert.equal(created.headers.get("cache-control"), "no-store");
  let state = await store.getCase(tenant1, caseId);
  assert.equal(state.revision, 1);
  assert.equal(state.waitReason, "agent_task");
  let outbox = await store.listOutboxForCase(tenant1, caseId);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].intentKind, "run_agent_task");
  assert.equal(outbox[0].status, "pending");
  assert.deepEqual(await usageLedger.listUsage(tenant1, caseId), []);

  const replay = await post(validBody, token1);
  assert.equal(replay.status, 202);
  assert.deepEqual(await replay.json(), { ...receipt, deduplicated: true });
  const conflict = await post(
    { ...validBody, budget: { amountMinor: 90000, currency: "GBP" } },
    token1,
  );
  assert.equal(conflict.status, 409);

  const second = await post(validBody, token2);
  assert.equal(second.status, 202);
  const receipt2 = await second.json();
  assert.equal(receipt2.deduplicated, false);
  assert.equal(receipt2.revision, 1);
  const state2 = await store.getCase(tenant2, caseId);
  assert.equal(state2.scope.tenantId, tenant2);
  assert.notEqual(state2.scope.relationshipId, state.scope.relationshipId);
  assert.equal((await store.getCase(tenant1, caseId)).revision, 1);
  t.diagnostic("intake: 401/400/413 rejected empty-handed; both tenants activated isolated cases");

  const runnerStarts = new Map();
  const rfqSink = new Map();
  const scoped = (tenantId, scopeCaseId, actorId, permissions) => ({
    tenantId,
    caseId: scopeCaseId,
    actorId,
    grantId: `grant-${actorId}`,
    permissions,
    validUntil: deadline,
  });
  const coordinatorNow = () => new Date(Date.now() + 1000);
  function makeTraceCoordinator() {
    return new ServiceCaseCoordinator({
      store,
      usageLedger,
      staleDispatchMs: 120000,
      now: coordinatorNow,
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
            authorityForJob: (job) => scoped(job.tenantId, job.caseId, "agent", ["agent.result"]),
            now: coordinatorNow,
          },
          async (jobSpec, controls) => {
            await controls.reserveModelCall();
            const key = `${jobSpec.tenantId}/${jobSpec.caseId}`;
            runnerStarts.set(key, (runnerStarts.get(key) ?? 0) + 1);
            return defaultScriptedCandidate(jobSpec);
          },
        ),
      requestSupplierQuote: async (rfq, context) => {
        const key = `${context.tenantId}/${context.caseId}/${rfq.id}`;
        if (!rfqSink.has(key)) rfqSink.set(key, structuredClone(rfq));
      },
      cancelAgentTask: async () => {},
    });
  }
  let coordinator = makeTraceCoordinator();

  let counter = 0;
  async function submit(tenantId, submitCaseId, body, actorId, permissions) {
    const current = await store.getCase(tenantId, submitCaseId);
    assert.ok(current, "case must exist");
    counter += 1;
    return coordinator.submitCommand(
      {
        ...body,
        commandId: `${submitCaseId}-client-${counter}`,
        tenantId,
        caseId: submitCaseId,
        expectedRevision: current.revision,
      },
      scoped(tenantId, submitCaseId, actorId, permissions),
    );
  }
  function applied(result) {
    assert.equal(result.decision.outcome, "applied", result.decision.reason);
    return result.decision;
  }

  const drain = await coordinator.drainCase(tenant1, caseId);
  assert.equal(drain.completed, 1);
  assert.equal(runnerStarts.get(`${tenant1}/${caseId}`), 1);
  state = await store.getCase(tenant1, caseId);
  assert.equal(state.activeTask, null);
  assert.equal(state.requirements.length, 1);
  assert.equal((await usageLedger.listUsage(tenant1, caseId)).length, 1);

  const requirementIds = state.requirements.map((requirement) => requirement.id);
  applied(
    await submit(
      tenant1,
      caseId,
      {
        kind: "request_quote",
        rfq: {
          id: `rfq-${caseId}`,
          supplierId: "supplier-fixture",
          briefVersion: 1,
          requirementIds,
        },
      },
      "runtime-fixture",
      ["supply.request"],
    ),
  );
  const rfqDrain = await coordinator.drainCase(tenant1, caseId);
  assert.equal(rfqDrain.completed, 1);
  assert.deepEqual([...rfqSink.keys()], [`${tenant1}/${caseId}/rfq-${caseId}`]);
  assert.equal(runnerStarts.get(`${tenant1}/${caseId}`), 1);
  state = await store.getCase(tenant1, caseId);
  assert.equal(state.waitReason, "supplier_quote");

  coordinator = makeTraceCoordinator();
  const recovered = await coordinator.recoverCase(tenant1, caseId);
  assert.equal(recovered.state.waitReason, "supplier_quote");
  assert.equal(rfqSink.size, 1);
  assert.equal(runnerStarts.get(`${tenant1}/${caseId}`), 1);

  const quote = {
    id: `quote-${caseId}`,
    version: 1,
    tenantId: tenant1,
    caseId,
    rfqId: `rfq-${caseId}`,
    briefVersion: 1,
    supplierId: "supplier-fixture",
    sellerId: "seller-fixture",
    fulfillerId: "hotel-fixture",
    payeeId: "seller-fixture",
    total: { amountMinor: 30000, currency: "GBP" },
    validUntil: fixtureDeadline(),
    availability: "quoted",
    evidenceRef: "synthetic:quote-response",
  };
  applied(
    await submit(tenant1, caseId, { kind: "record_quote", quote }, "supplier-fixture", [
      "supply.record",
    ]),
  );
  const scope = { kind: "supplier_handoff", supplierId: quote.supplierId, lineIds: [quote.id] };
  const termsHash = createHash("sha256")
    .update(
      canonicalJson({
        quoteId: quote.id,
        quoteVersion: quote.version,
        total: quote.total,
        validUntil: quote.validUntil,
        scope,
      }),
    )
    .digest("hex");
  const proposal = {
    id: `proposal-${caseId}`,
    version: 1,
    tenantId: tenant1,
    caseId,
    briefVersion: 1,
    quoteId: quote.id,
    quoteVersion: 1,
    termsHash,
    total: quote.total,
    validUntil: quote.validUntil,
    approverActorId: "payer-fixture",
    scope,
  };
  applied(
    await submit(tenant1, caseId, { kind: "stage_proposal", proposal }, "runtime-fixture", [
      "proposal.write",
    ]),
  );
  applied(
    await submit(tenant1, caseId, { kind: "publish_proposal" }, "runtime-fixture", [
      "proposal.write",
    ]),
  );
  const approval = {
    id: `approval-${caseId}`,
    tenantId: tenant1,
    caseId,
    proposalId: proposal.id,
    proposalVersion: 1,
    termsHash,
    total: quote.total,
    validUntil: quote.validUntil,
    scope,
    approvedBy: "payer-fixture",
    authorityGrantId: "grant-payer-fixture",
    approvedAt: new Date().toISOString(),
  };
  const wrongApprover = await submit(
    tenant1,
    caseId,
    { kind: "approve_proposal", approval },
    "operator-fixture",
    ["proposal.approve"],
  );
  assert.equal(wrongApprover.decision.outcome, "rejected");
  assert.equal(wrongApprover.decision.reason, "approval_authority_mismatch");
  applied(
    await submit(tenant1, caseId, { kind: "approve_proposal", approval }, "payer-fixture", [
      "proposal.approve",
    ]),
  );

  const actionId = `action-${caseId}`;
  const clientReference = `client-ref-${caseId}`;
  const requestHash = createHash("sha256")
    .update(
      canonicalJson({
        actionId,
        clientReference,
        proposalId: proposal.id,
        proposalVersion: proposal.version,
        total: proposal.total,
        validUntil: proposal.validUntil,
        termsHash: proposal.termsHash,
        scope: proposal.scope,
      }),
    )
    .digest("hex");
  const supplier = new FakeSupplierAdapter(
    tenant1,
    {
      supplierId: "supplier-fixture",
      destinations: ["GB"],
      currencies: ["GBP"],
      supportsLookup: true,
      supportsIdempotency: false,
      supportsCancel: false,
    },
    "dropResponseAfterAccept",
  );
  const dispatchAuthority = scoped(tenant1, caseId, "runtime-fixture", [
    "handoff.dispatch",
    "supply.record",
    "action.reconcile",
  ]);
  const dispatchContext = { tenantId: tenant1, caseId, actionId, authority: dispatchAuthority };
  await new DeterministicEffectDispatcher(store, supplier).dispatchApprovedHandoff({
    ...dispatchContext,
    clientReference,
    requestHash,
    now: new Date(),
  });
  state = await store.getCase(tenant1, caseId);
  assert.equal(state.action.status, "unknown");
  assert.equal(state.action.id, actionId);
  assert.equal(state.action.clientReference, clientReference);
  assert.equal(state.action.requestHash, requestHash);
  assert.equal(state.waitReason, "reconciliation");
  assert.equal(state.payment, "unobserved");
  assert.equal(supplier.orderCount, 1);
  assert.equal(supplier.submitCalls, 1);

  await assert.rejects(
    new DeterministicEffectDispatcher(store, supplier).retryApprovedHandoff({
      ...dispatchContext,
      attempt: 1,
      now: new Date(),
    }),
    /reconciliation_required/,
  );
  assert.equal(supplier.orderCount, 1);
  assert.equal(supplier.submitCalls, 1);

  applied(
    await submit(
      tenant1,
      caseId,
      { kind: "record_payment", total: quote.total, evidenceRef: "synthetic:payment-observation" },
      "runtime-fixture",
      ["fulfillment.record"],
    ),
  );
  state = await store.getCase(tenant1, caseId);
  assert.equal(state.payment, "paid");
  assert.equal(state.booking, "pending");

  await new DeterministicEffectDispatcher(store, supplier).reconcileUnknownAction({
    ...dispatchContext,
    now: new Date(),
  });
  state = await store.getCase(tenant1, caseId);
  assert.equal(state.booking, "confirmed");
  assert.equal(state.payment, "paid");
  assert.equal(state.fulfillment, "pending");
  assert.equal(state.action.status, "confirmed");
  assert.equal(state.action.id, actionId);
  assert.equal(state.action.clientReference, clientReference);
  assert.equal(state.action.requestHash, requestHash);

  applied(
    await submit(
      tenant1,
      caseId,
      { kind: "record_fulfillment", evidenceRef: "synthetic:service-delivered" },
      "runtime-fixture",
      ["fulfillment.record"],
    ),
  );
  applied(
    await submit(tenant1, caseId, { kind: "close", outcome: "fulfilled" }, "runtime-fixture", [
      "case.close",
    ]),
  );
  state = await store.getCase(tenant1, caseId);
  assert.equal(state.phase, "closed");
  assert.equal(state.outcome, "fulfilled");
  assert.equal(supplier.orderCount, 1);
  assert.equal(supplier.submitCalls, 1);
  assert.equal(runnerStarts.get(`${tenant1}/${caseId}`), 1);
  t.diagnostic(
    `case ${caseId}: unknown handoff reconciled to confirmed; 1 order, 1 submit, 1 runner start`,
  );

  const caseId2 = "case-london-2";
  const token3 = randomUUID();
  grants.set(`Bearer ${token3}`, grantFixture(tenant1, caseId2, grant1.relationship));
  const followup = await post({ ...validBody, commandId: `intake-${randomUUID()}` }, token3);
  assert.equal(followup.status, 202);
  const receipt3 = await followup.json();
  assert.equal(receipt3.caseId, caseId2);
  assert.equal(receipt3.revision, 1);
  assert.equal((await store.getCase(tenant1, caseId)).phase, "closed");
  const state3 = await store.getCase(tenant1, caseId2);
  assert.equal(state3.approval, null);
  assert.equal(state3.action, null);
  assert.deepEqual(await usageLedger.listUsage(tenant1, caseId2), []);
  const drain3 = await coordinator.drainCase(tenant1, caseId2);
  assert.equal(drain3.completed, 1);
  assert.equal(runnerStarts.get(`${tenant1}/${caseId2}`), 1);
  assert.equal(runnerStarts.get(`${tenant1}/${caseId}`), 1);
  t.diagnostic("follow-up case: separate allowance and runner usage; original case remains closed");
});
