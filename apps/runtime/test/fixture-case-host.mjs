import { appendFile } from "node:fs/promises";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { PostgresCaseStore, PostgresUsageLedger } from "@occavoy/storage";
import pg from "pg";
import { createClient } from "rivetkit/client";
import { BudgetExhaustedError } from "../dist/case-job-adapter.js";
import { readRuntimeConfig } from "../dist/protocol.js";
import { createRuntimeRegistry } from "../dist/registry.js";
import { createFixtureCaseJob, jobCredential } from "./fixture-case-job.mjs";

const config = readRuntimeConfig(process.env);
const database = new URL(config.databaseUrl);
if (
  process.env.NODE_ENV !== "test" ||
  config.mode !== "local" ||
  database.host !== "127.0.0.1:54329" ||
  database.pathname !== "/occavoy" ||
  !/^-c search_path=pi_case_[a-f0-9]{32}$/.test(database.searchParams.get("options"))
) {
  throw new Error("Only the disposable local case-recovery schema is supported");
}
const pool = new pg.Pool({ connectionString: database.href });
const client = createClient(`http://127.0.0.1:${Number(process.env.RIVET_RUN_ENGINE_PORT)}`);
const job = (key) =>
  client.caseJob.getOrCreate(key, { params: { credential: jobCredential(config.demoToken, key) } });

// Observations for the fault injector, never inputs to recovery or to a decision.
const observe = (event) =>
  appendFile("observations.jsonl", `${JSON.stringify(event)}\n`, { mode: 0o600 });
const caseJob = createFixtureCaseJob({
  secret: config.demoToken,
  store: new PostgresCaseStore(pool),
  ledger: new PostgresUsageLedger(pool),
  onRead: async (key) => {
    await observe({ kind: "read-start", key });
    return process.env.CASE_FIXTURE_HOLD === "1";
  },
});

async function abortJob(key) {
  const actor = job(key);
  await actor.conversation.abort((await actor.harness.root()).id);
}

async function invoke({ key, spec, requestId, controls: { signal } }) {
  const actor = job(key);
  signal.throwIfAborted();
  const prompt = await actor.admit(spec);
  signal.throwIfAborted();
  try {
    const { submissionId } = await actor.submit(prompt, { requestId });
    await observe({ kind: "submit", key, requestId, submissionId, deadlineAt: spec.deadlineAt });
    for (;;) {
      signal.throwIfAborted();
      const status = await actor.submission.status(submissionId);
      if (status.requestId !== requestId || status.type !== "input")
        throw new Error("Wrong submission");
      if (status.status === "done") {
        // Look up this submission's answer, not the last message in a transcript.
        const page = await actor.conversation.entries(
          status.conversationId,
          { minEntryId: status.answer, maxEntryId: status.answer },
          1,
        );
        const message = page.items[0]?.model?.[0];
        if (
          message?.role !== "assistant" ||
          message.content.length !== 1 ||
          message.content[0].type !== "text" ||
          Buffer.byteLength(message.content[0].text) > 4096
        ) {
          throw new Error("Expected a bounded JSON candidate");
        }
        return JSON.parse(message.content[0].text);
      }
      if (status.status === "unanswered") {
        if (await actor.budgetDenied()) throw new BudgetExhaustedError();
        throw new Error(`Fixture submission unanswered: ${status.reason}`);
      }
      await delay(100, undefined, { signal });
    }
  } finally {
    // A transport timeout is not a cancellation. The adapter's signal represents
    // the actual business cancellation / original deadline, never a fresh lease.
    if (signal.aborted) await abortJob(key);
  }
}

createRuntimeRegistry(
  config,
  {
    staleDispatchMs: 5000,
    piJobInvoker: invoke,
    cancelAgentTask: (task) => abortJob([task.tenantId, task.caseId, task.taskId]),
    requestSupplierQuote: (rfq, context) =>
      observe({ kind: "synthetic-rfq", id: rfq.id, ...context }),
  },
  { caseJob },
).start();

const server = createServer((req, res) => res.writeHead(req.url === "/healthz" ? 200 : 404).end());
server.listen(config.port, "127.0.0.1");
process.once("SIGTERM", () => server.close());
