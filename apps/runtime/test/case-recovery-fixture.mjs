import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { demoEvents } from "@occavoy/domain";
import { applyMigrations, PostgresCaseStore, PostgresUsageLedger } from "@occavoy/storage";
import pg from "pg";
import { createClient } from "rivetkit/client";
import { createCaseIntakeHandler } from "../../web/src/server/case-intake.ts";
import { agentCandidateCommandId } from "../dist/case-job-adapter.js";
import { jobCredential } from "./fixture-case-job.mjs";
import { createNativeHost, poll } from "./native-host.mjs";

// Deliberately not DATABASE_URL: this destructive process test is for the
// repository's disposable Compose database only (and never interrupts PG).
const compose = "postgresql://occavoy:occavoy@127.0.0.1:54329/occavoy";

export async function runCaseRecovery(t, { present, walkthrough = false } = {}) {
  const schema = `pi_case_${randomUUID().replaceAll("-", "")}`;
  const database = new URL(compose);
  database.searchParams.set("options", `-c search_path=${schema}`);
  const admin = new pg.Pool({ connectionString: compose });
  const pool = new pg.Pool({ connectionString: database.href });
  const store = new PostgresCaseStore(pool);
  const ledger = new PostgresUsageLedger(pool);
  const cwd = await mkdtemp(join(tmpdir(), "occavoy-pi-case-"));
  const secret = randomBytes(32).toString("hex");
  const server = createServer();
  let created = false;
  let host;
  const ownedCleanups = [];
  let cleanupPromise;
  async function cleanupOwned({ crashRuntime = false } = {}) {
    if (!cleanupPromise) {
      cleanupPromise = (async () => {
        let firstError;
        const capture = async (operation) => {
          try {
            await operation();
          } catch (error) {
            firstError ??= error;
          }
        };
        for (const cleanup of ownedCleanups.slice().reverse()) {
          await capture(() => cleanup({ crashRuntime }));
        }
        await capture(() => host?.stop(crashRuntime));
        await capture(async () => {
          if (server.listening) {
            const closing = new Promise((resolve) => server.close(resolve));
            server.closeIdleConnections?.();
            server.closeAllConnections?.();
            await closing;
          }
        });
        await capture(() => pool.end());
        if (created) await capture(() => admin.query(`DROP SCHEMA ${schema} CASCADE`));
        await capture(() => admin.end());
        await capture(() => rm(cwd, { recursive: true, force: true }));
        if (firstError) throw firstError;
      })();
    }
    return cleanupPromise;
  }
  function registerOwnedCleanup(cleanup) {
    ownedCleanups.push(cleanup);
  }
  t.after(() => cleanupOwned());
  if (walkthrough) {
    const installSignalCleanup = (signal, exitCode) => {
      process.once(signal, () => {
        const forceExit = setTimeout(() => process.exit(exitCode), 10_000);
        void cleanupOwned({ crashRuntime: true }).finally(() => {
          clearTimeout(forceExit);
          process.exit(exitCode);
        });
      });
    };
    installSignalCleanup("SIGINT", 130);
    installSignalCleanup("SIGTERM", 143);
  }
  await admin.query(`CREATE SCHEMA ${schema}`);
  created = true;
  await applyMigrations(pool);
  const tenantId = `fixture-${randomUUID()}`;
  const caseId = "london-recovery";
  const scope = [tenantId, caseId];
  const deadline = new Date(Date.now() + (walkthrough ? 15 * 60_000 : 180_000)).toISOString();
  const grant = {
    authority: {
      tenantId,
      caseId,
      actorId: "fixture-customer",
      grantId: "fixture-intake",
      permissions: ["case.edit"],
      validUntil: deadline,
    },
    relationship: {
      tenantId,
      id: "fixture-relationship",
      customerId: "fixture-customer",
      preferenceReuseAllowed: false,
    },
    approverActorId: "fixture-payer",
    deadline,
  };
  if (present) grant.approverActorId = grant.relationship.customerId;
  const view = await present?.({
    t,
    store,
    ledger,
    grant,
    walkthrough,
    registerCleanup: registerOwnedCleanup,
  });
  const bearer = `Bearer ${randomUUID()}`;
  const handle = createCaseIntakeHandler({
    resolveGrant: async (authorization) => (authorization === bearer ? grant : null),
    findEvent: (id) => demoEvents.find((event) => event.id === id),
    store,
    taskAllowance: { maxModelCalls: 2, maxToolCalls: 2 },
  });
  server.on("request", async (req, res) => {
    try {
      const response = await handle(
        new Request(new URL(req.url, "http://127.0.0.1"), {
          method: req.method,
          headers: req.headers,
          body: req,
          duplex: "half",
        }),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(500).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const body = {
    activate: true,
    eventId: "fixture-london",
    commandId: randomUUID(),
    budget: { amountMinor: 73100, currency: "GBP" },
  };
  async function activate() {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/cases`, {
      method: "POST",
      headers: { authorization: bearer, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 202);
    return res.json();
  }
  const receipt = await activate();
  assert.deepEqual(receipt, {
    commandId: body.commandId,
    caseId,
    revision: 1,
    briefVersion: 1,
    deduplicated: false,
  });
  const [intent] = await store.listOutboxForCase(...scope);
  assert.equal(intent.status, "pending");
  assert.equal(intent.intentKind, "run_agent_task");
  const task = intent.payload.task;
  const key = [...scope, task.taskId];
  const requestId = task.taskId;
  const spec = {
    tenantId,
    caseId,
    taskId: task.taskId,
    requestId,
    baseRevision: 1,
    briefVersion: 1,
    deadlineAt: deadline,
    maxModelCalls: 2,
    maxToolCalls: 2,
    toolProfile: "case_readonly_v1",
    purpose: "derive_requirements",
  };
  assert.equal((await store.getCommand(tenantId, receipt.commandId)).outcome, "applied");
  assert.deepEqual(await ledger.listUsage(...scope), []);
  await view?.saved();

  host = await createNativeHost({
    cwd,
    entry: fileURLToPath(new URL("./fixture-case-host.mjs", import.meta.url)),
    args: ["--import", import.meta.resolve("tsx")],
    env: { DATABASE_URL: database.href, OCCAVOY_RUNTIME_DEMO_TOKEN: secret },
  });
  const cases = () =>
    createClient(host.endpoint).serviceCase.getOrCreate(scope, { params: { authToken: secret } });
  const job = () =>
    createClient(host.endpoint).caseJob.getOrCreate(key, {
      params: { credential: jobCredential(secret, key) },
    });
  const audit = async () => {
    let text;
    try {
      text = await readFile(join(cwd, "observations.jsonl"), "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    return text
      .split("\n")
      .slice(0, -1)
      .map((line) => JSON.parse(line));
  };
  const usage = async () =>
    (await ledger.listUsage(...scope)).map((row) => {
      assert.equal(row.admitted, true);
      assert.equal(row.taskId, task.taskId);
      assert.equal(row.relationshipId, grant.relationship.id);
      assert.equal(row.metadata.requestId, requestId);
      assert.equal(row.quantity, 1);
      return row.kind;
    });

  await host.start({ CASE_FIXTURE_HOLD: "1" });
  await cases().status(); // Wake the case actor; its normal scheduled action claims the PG intent.
  const before = await poll(
    audit,
    (events) =>
      events.some((e) => e.kind === "read-start") && events.some((e) => e.kind === "submit"),
    "first leased task entered replay-safe read",
  );
  const submit = before.find((e) => e.kind === "submit");
  assert.deepEqual(submit.key, key);
  assert.equal(submit.requestId, requestId);
  assert.equal(submit.deadlineAt, deadline);
  const { submissionId } = submit;
  assert.ok(submissionId);
  assert.deepEqual(await usage(), ["model_call", "tool_call"]);
  assert.deepEqual((await store.getCase(...scope)).activeTask, task);
  const [leased] = await store.listOutboxForCase(...scope);
  assert.equal(leased.id, intent.id);
  assert.equal(leased.status, "dispatched");
  assert.equal(leased.attempts, 1);
  const running = await job().submission.status(submissionId);
  assert.equal(running.requestId, requestId);
  assert.deepEqual(
    (await job().harness.inspect()).submissions.map((s) => s.id),
    [submissionId],
  );
  const prompt = await job().admit(spec);
  await assert.rejects(job().admit({ ...spec, briefVersion: 2 }));
  await host.stop(true);
  assert.equal((await store.getCase(...scope)).waitReason, "agent_task");
  await view?.interrupted();

  await host.start(); // Same engine directory and schema; no hold and no new admission window.
  const coordinator = cases();
  await coordinator.status();
  const outbox = await poll(
    () => store.listOutboxForCase(...scope),
    (rows) => rows[0]?.status === "completed",
    "redelivery and candidate CAS",
    Date.parse(deadline) - Date.now(),
  );
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].id, leased.id);
  assert.equal(outbox[0].attempts, 2);
  const recovered = await job().submission.status(submissionId);
  assert.equal(recovered.status, "done");
  assert.equal(recovered.requestId, requestId);
  assert.deepEqual(
    (await audit()).filter((e) => e.kind === "submit"),
    [submit, submit],
  );
  assert.deepEqual(
    (await audit()).filter((e) => e.kind === "read-start").map((e) => e.key),
    [key, key],
  );
  const state = await store.getCase(...scope);
  assert.equal(state.revision, 2);
  assert.equal(state.activeTask, null);
  const candidateId = agentCandidateCommandId(spec);
  const candidate = await store.getCommand(tenantId, candidateId);
  assert.equal(candidate.outcome, "applied");
  assert.deepEqual(candidate.command.candidate.task, task);
  assert.deepEqual(state.requirements, [
    {
      id: "access-fixture-london",
      category: "event_access",
      description:
        "Request access options for fixture-london in London; brief budget 73100 minor units GBP.",
    },
  ]);
  assert.deepEqual(await usage(), ["model_call", "tool_call", "tool_call", "model_call"]);

  // Only the coordinator receives the separate, synthetic supply.request grant.
  const rfq = {
    command: {
      kind: "request_quote",
      tenantId,
      caseId,
      expectedRevision: 2,
      commandId: `quote-${requestId}`,
      rfq: {
        id: `rfq-${requestId}`,
        supplierId: "fixture-supplier",
        briefVersion: task.briefVersion,
        requirementIds: state.requirements.map((r) => r.id),
      },
    },
    authority: {
      tenantId,
      caseId,
      grantId: "fixture-supply",
      actorId: "fixture-coordinator",
      permissions: ["supply.request"],
      validUntil: deadline,
    },
  };
  assert.equal((await coordinator.submit(rfq)).decision.outcome, "applied");
  await coordinator.drain();
  const settledUsage = await ledger.listUsage(...scope);
  if (!present) {
    assert.deepEqual(await activate(), { ...receipt, deduplicated: true });
  }
  assert.deepEqual((await job().submit(prompt, { requestId })).submissionId, submissionId);
  assert.equal((await coordinator.submit(rfq)).deduplicated, true);
  await coordinator.drain();
  const final = await store.getCase(...scope);
  assert.equal(final.revision, 3);
  assert.equal(final.waitReason, "supplier_quote");
  assert.equal(final.action, null);
  assert.equal(final.approval, null);
  assert.equal(final.quotes.length, 0);
  const rows = await store.listOutboxForCase(...scope);
  assert.deepEqual(
    rows.map((r) => [r.intentKind, r.status, r.attempts]),
    [
      ["run_agent_task", "completed", 2],
      ["request_supplier_quote", "completed", 1],
    ],
  );
  const timeline = await store.getTimeline(...scope);
  assert.deepEqual(
    timeline.filter((e) => e.eventKind === "command.agent_candidate").map((e) => e.commandId),
    [candidateId],
  );
  assert.deepEqual(
    timeline.filter((e) => e.eventKind === "intent.request_supplier_quote").map((e) => e.commandId),
    [rfq.command.commandId],
  );
  assert.deepEqual(
    (await audit()).filter((e) => e.kind === "synthetic-rfq").map((e) => e.outboxId),
    [rows[1].id],
  );
  // inspect() lists queued/placed inputs only. The original settled input
  // remains addressable by ID, while no model work is left awaiting a supplier.
  assert.deepEqual((await job().harness.inspect()).submissions, []);
  assert.deepEqual(await job().submission.status(submissionId), recovered);
  assert.deepEqual(await ledger.listUsage(...scope), settledUsage);
  const allowance = await ledger.getAllowance(...scope);
  assert.deepEqual(
    [allowance.usedModelCalls, allowance.usedToolCalls, allowance.usedCostMinor],
    [2, 2, 0],
  );
  const usageBeforeContinuation = await ledger.listUsage(...scope);
  await view?.continueFromRfq(coordinator);
  assert.deepEqual(await ledger.listUsage(...scope), usageBeforeContinuation);
  t.diagnostic(
    present
      ? "1 submission / 2 intent deliveries; 2 faux model turns / 2 safe read starts; 1 accepted candidate / 1 synthetic RFQ; commercial continuation used no model allowance"
      : "1 submission / 2 intent deliveries; 2 faux model turns / 2 safe read starts; 1 accepted candidate / 1 synthetic RFQ; supplier_quote, no external effects",
  );
}
