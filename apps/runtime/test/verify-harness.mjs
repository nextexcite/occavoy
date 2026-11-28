import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "rivetkit/client";
import { createProbeCredential, PROBE_LIMITS } from "../dist/probe-protocol.js";
import { createNativeHost, poll } from "./native-host.mjs";

if (process.platform === "win32")
  throw new Error("The process-crash qualification requires POSIX process signals.");

const directory = await mkdtemp(join(tmpdir(), "occavoy-harness-"));
const serverPath = fileURLToPath(new URL("../dist/server.js", import.meta.url));
const secret = randomBytes(32).toString("hex");
const host = await createNativeHost({
  entry: serverPath,
  cwd: directory,
  env: { OCCAVOY_RUNTIME_DEMO_TOKEN: secret },
});
const endpoint = host.endpoint;
let client;
const evidence = [];

async function start(holdAt) {
  await host.start(holdAt ? { OCCAVOY_PROBE_HOLD: holdAt } : {});
  client = createClient(endpoint);
}

function handle(key, credential = createProbeCredential(secret, key)) {
  return client.reasoningProbe.getOrCreate(key, { params: { credential } });
}

async function admit(scenario) {
  const key = ["qualification-tenant", "global-case", randomUUID()];
  const actor = handle(key);
  const admission = await actor.admit({ requestId: "request-1", baseRevision: 7, scenario });
  return { key, admission, root: await actor.harness.root() };
}

async function submit(job, requestId = job.admission.requestId, prompt = job.admission.prompt) {
  const result = await handle(job.key).submit(prompt, { requestId });
  return { ...job, submissionId: result.submissionId };
}

async function settled(job, timeoutMs) {
  return poll(
    () => handle(job.key).submission.status(job.submissionId),
    (status) => ["done", "unanswered"].includes(status.status),
    "Submission settlement",
    timeoutMs,
  );
}

// A replacement engine may still be detecting the lost actor at the normal poll timeout.
// Use the original admission deadline; a restart must not grant the job more time.
function settledAfterRestart(job, beforeCrash) {
  return settled(job, Math.max(0, beforeCrash.ledger.admission.deadlineAt - Date.now()));
}

async function stop(crash = false) {
  await host.stop(crash);
}

try {
  await start("safe");
  const normal = await submit(await admit("summary"));
  assert.equal((await settled(normal)).status, "done");
  const before = await handle(normal.key).probeStatus();
  assert.equal(before.ledger.modelAttempts, 3);
  assert.equal(before.ledger.readStarts, 1);
  assert.equal(before.ledger.summaryWrites, 1);
  assert.equal(before.ledger.summary.baseRevision, 7);
  assert.deepEqual(before.ledger.summary.destinations, ["Tokyo", "Paris"]);
  const duplicate = await handle(normal.key).submit(normal.admission.prompt, {
    requestId: normal.admission.requestId,
  });
  assert.deepEqual(duplicate.submissionId, normal.submissionId);
  assert.deepEqual((await handle(normal.key).probeStatus()).ledger, before.ledger);
  await assert.rejects(
    handle(normal.key).admit({ requestId: "request-1", baseRevision: 8, scenario: "summary" }),
  );
  evidence.push(
    "real Pi model → read tool → result tool → final response; stable requestId deduplicates without reexecution",
  );

  const other = await admit("summary");
  await assert.rejects(handle(other.key, createProbeCredential(secret, normal.key)).probeStatus());
  const wrongPrompt = await submit(other, "cross-scope-attempt", normal.admission.prompt);
  assert.equal((await settled(wrongPrompt)).status, "unanswered");
  assert.equal((await handle(other.key).probeStatus()).ledger.modelAttempts, 0);
  assert.equal((await handle(other.key).probeStatus()).ledger.toolExecutions, 0);
  assert.deepEqual((await handle(normal.key).probeStatus()).ledger, before.ledger);
  const firstModel = (await handle(normal.key).conversation.agent(normal.root.id)).model;
  await assert.rejects(
    handle(other.key).conversation.configure(other.root.id, { model: firstModel }),
  );
  await assert.rejects(
    handle(other.key).harness.createConversation({
      ownership: { kind: "ownerless" },
      agent: { model: firstModel },
    }),
  );
  evidence.push(
    "actor-scoped credential, foreign signed prompt, and cross-actor model selection rejected",
  );

  const overBudget = await submit(normal, "explicit-second-run");
  assert.equal((await settled(overBudget)).status, "unanswered");
  const bounded = (await handle(normal.key).probeStatus()).ledger;
  assert.equal(bounded.modelAttempts, PROBE_LIMITS.modelAttempts);
  assert.equal(bounded.summaryWrites, 1);
  evidence.push("durable per-job model allowance applies across separate submissions");

  const looping = await submit(await admit("turn_limit"));
  const loopOutcome = await settled(looping);
  assert.equal(loopOutcome.status, "unanswered");
  assert.equal(loopOutcome.reason, "turn_limit");
  assert.equal(
    (await handle(looping.key).probeStatus()).ledger.readStarts,
    PROBE_LIMITS.toolRounds,
  );
  const expired = await submit(await admit("deadline"));
  assert.equal((await settled(expired)).status, "unanswered");
  assert.equal((await handle(expired.key).probeStatus()).ledger.summaryWrites, 0);
  evidence.push(
    "persisted tool-round limit and admission deadline stop work without a commercial effect",
  );

  const safe = await submit(await admit("safe_interrupt"));
  const safeBeforeCrash = await poll(
    () => handle(safe.key).probeStatus(),
    (status) => status.ledger.readStarts === 1,
    "Safe tool start",
  );
  await stop(true);
  await start();
  assert.equal((await settledAfterRestart(safe, safeBeforeCrash)).status, "done");
  const recoveredSafe = (await handle(safe.key).probeStatus()).ledger;
  assert.equal(recoveredSafe.readStarts, 2);
  assert.equal(recoveredSafe.summaryWrites, 1);
  assert.equal(recoveredSafe.modelAttempts, 3);
  assert.deepEqual(
    (await handle(safe.key).submit(safe.admission.prompt, { requestId: safe.admission.requestId }))
      .submissionId,
    safe.submissionId,
  );
  evidence.push(
    "SIGKILL during replay-safe read: saved model decision reused, interrupted read resumes, one result receipt",
  );

  await stop();
  await start("unsafe");
  const unsafe = await submit(await admit("unsafe_interrupt"));
  const unsafeBeforeCrash = await poll(
    () => handle(unsafe.key).probeStatus(),
    (status) => status.ledger.summaryWrites === 1,
    "Unsafe tool receipt",
  );
  await stop(true);
  await start();
  assert.equal((await settledAfterRestart(unsafe, unsafeBeforeCrash)).status, "done");
  const recoveredUnsafe = (await handle(unsafe.key).probeStatus()).ledger;
  assert.equal(recoveredUnsafe.summaryStarts, 1);
  assert.equal(recoveredUnsafe.summaryWrites, 1);
  const context = await handle(unsafe.key).conversation.context(unsafe.root.id);
  assert.ok(
    context.messages.some(
      (message) =>
        message.role === "toolResult" &&
        message.toolName === "record_case_summary" &&
        message.isError,
    ),
  );
  evidence.push(
    "SIGKILL after unsafe synthetic receipt: tool is not replayed; transcript records interrupted outcome",
  );
  console.log(
    JSON.stringify(
      {
        passed: true,
        scope: "local-pi-durable-on-rivet",
        provider: "scripted-faux",
        paidModelCalls: 0,
        externalEffects: 0,
        cloudTested: false,
        evidence,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(host.logs());
  throw error;
} finally {
  await stop();
  await rm(directory, { recursive: true, force: true });
}
