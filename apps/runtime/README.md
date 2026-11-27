# Occavoy runtime qualification fixtures

This package contains two real Rivet 3.1.1 qualification fixtures with synthetic data, plus the initial production-shaped service-case slice:

- **`demoCase`** is the earlier command/workflow probe. It waits for client input, supports pause/resume, and prevents duplicate commands from applying twice. Its native queue API is deprecated and remains an isolated compatibility fixture.
- **`reasoningProbe`** uses the official `@rivet-dev/pi` adapter and Pi Durable inside an Actor. Its scripted model provider drives the actual model/tool loop and persisted tool tasks. It proves harness invocation and recovery without purchasing model calls.
- **`serviceCase`** is the deterministic case coordinator. Postgres is the authority for case state, commands, domain events, outbox intents, and usage; actor SQLite storage is limited to a recoverable drain schedule receipt.

Neither fixture books, charges, contacts a supplier, or creates a sandbox. The service-case slice does not invent inventory, supplier access, or verified prices. Actor-local demonstration records are not the production ServiceCase authority. Use synthetic text only. The test credentials are not production tenant authentication.

## Service-case authority slice

`serviceCase` uses supported Rivet actor actions and scheduling, not the legacy queue API. `PostgresCaseStore` accepts or completes commands transactionally with domain events and outbox intents. The coordinator claims due outbox rows with database locking, starts bounded job adapters, requeues stale dispatch claims, and leaves supplier waiting as durable state rather than holding a model loop open. `supplier_handoff` remains outside this slice and is rejected until its effect dispatcher exists.

`CaseJobAdapter` is the typed boundary for bounded reasoning jobs. Its immutable job specification carries tenant, case, task, request ID, base case revision, brief version, deadline, purpose, and tool profile. The Pi hook uses the `[tenantId, caseId, jobId]` actor key and must retry transport failures with the original request ID. Raw model output is never cast directly to a domain candidate: the adapter validates the candidate shape and exact job fence, then submits one `agent_candidate` command through Postgres. Cancellation aborts local work promptly and exposes an idempotent Pi cancellation hook; late candidates are still subject to the domain revision fence.

`PostgresUsageLedger` reserves model/tool usage before paid steps. Its counters are stored in `case_allowances`; every admitted or denied attempt is attributed in `case_usage_ledger` with a cost category. Exhaustion atomically pauses the case allowance with `budget_exhausted`, blocking further discretionary paid work while still permitting controlled `reconciliation_lookup` attribution for existing unknown obligations. Closing a case closes only that case allowance, not the customer relationship.

The runtime build typechecks and then bundles the runtime with first-party workspace TypeScript into `dist` using esbuild. Versioned third-party runtime dependencies remain external, so the production image does not execute TypeScript sources from `node_modules`.

## Durable reasoning probe

The selected compatible combination is `@rivet-dev/pi` **0.5.7**, `@earendil-works/{chord,pi-ai,pi-durable,pi-schema,pi-telemetry}` **1.5.2**, and `rivetkit` **3.1.1**. Pi 1.6.1 is newer but falls outside this adapter's `~1.5.0` peer range. The adapter accepts Rivet 3.x. Pi Durable remains experimental; these exact pins are a tested combination, not a claim of a stable future API. See the [published adapter manifest](https://registry.npmjs.org/@rivet-dev%2fpi/0.5.7) and [official integration guide](https://rivet.dev/ecosystem/pi-durable/).

Run the qualification without a model key or a separately running server:

```sh
mise exec -- pnpm --filter @occavoy/runtime verify:harness
```

The test runs local native Rivet, Pi Durable, and Pi's in-process faux provider. The provider emits tool calls; Pi validates and executes them, persists their outcomes, and requests the next model response. A signed admission fixes one job, its case revision, scenario, and deadline. The actor key is `[tenant, case, job]`. There are exactly two registered tools: a synthetic case read and a synthetic structured-result receipt. No built-in file, shell, browser, or commerce tools are installed.

This is the backend invocation path against a running local server:

```ts
import { createClient } from "rivetkit/client";
import { createProbeCredential } from "./src/probe-protocol.js";
import type { RuntimeRegistry } from "./src/registry.js";

const key = ["demo-tenant", "global-case", "job-1"];
const secret = process.env.OCCAVOY_RUNTIME_DEMO_TOKEN!;
const client = createClient<RuntimeRegistry>("http://localhost:6420");
const task = client.reasoningProbe.getOrCreate(key, {
  params: { credential: createProbeCredential(secret, key) },
});
const admitted = await task.admit({
  requestId: "command-1",
  baseRevision: 7,
  scenario: "summary",
});
const { submissionId } = await task.submit(admitted.prompt, {
  requestId: admitted.requestId,
});
const progress = await task.submission.status(submissionId);
// A short-lived test/client may also wait; the web request need not stay open.
const outcome = await task.submission.wait(submissionId);
const recorded = await task.probeStatus();
```

`submit` acknowledges a persisted submission. `done` and `unanswered` are distinct outcomes; a fulfilled RPC is not evidence of a successful model run. Retrying the same request ID returns the same submission. `admit` rejects a changed payload or case revision for the same job. The production coordinator must derive the job and request identity from its durable command; this fixture's two client calls do not implement a production outbox dispatcher.

Model routing is bound internally to the actual Actor ID, independently of prompt content. Credentials are bound to the three-part Actor key. A valid prompt from Actor A cannot charge A's budget while executing in B. Client model switching has an empty allowlist; the host sets the fixture model. This demonstrates these specific boundaries, not a production login, authorization service, or permission review of every generic Pi RPC. Production clients should use the application API rather than a general harness administration interface.

The durable fixture allowance is **4 model attempts**, **4 tool executions including replays**, **3 tool rounds per run**, and **60 seconds per admitted job**. The deadline scenario uses one second to exercise expiry. Provider admission commits the model-attempt reservation before producing a response; tool entry commits its reservation before work. Limits persist across separate submissions and process replacement. Ordinary Pi hook exceptions can be reported and swallowed, so they are not the enforcement boundary. Output is synthetic and capped at 4,096 bytes; the provider rejects prompt input over 2,048 bytes. These checks do not implement monetary reservations or a general transcript-storage quota.

**Observed on 2026-11-27:** `verify:harness` passed on Node 26.13.1. It verified the real tool round trip, duplicate-request deduplication, changed-admission rejection, key/foreign-prompt/model-selection isolation, the model allowance, tool-round limit, deadline, and two SIGKILL recovery boundaries. For a `replay:"safe"` read, the interrupted tool runs again while the saved model decision is reused. For the `replay:"unsafe"` result tool, the test kills the process after its synthetic receipt commits but before its result returns: the tool is not replayed and the transcript records an interrupted outcome. This is not an exactly-once claim about an external supplier or payment.

The crash test kills the owned runtime and its local engine, reopens their local data, and uses read-only status polling to observe recovery. It has no paid model calls and no external effects. It does not establish cloud recovery, disk-loss recovery, model quality, model pricing, or production transaction correctness. Connecting the probe's `baseRevision` to the domain's case/brief versions, authoritative result acceptance, PostgreSQL persistence, real model access, and provider reconciliation remains separate work.

A long-lived ServiceCase coordinator and a bounded AgentTask are separate responsibilities. The intended task key is `[tenant, case, job]`; a customer relationship can outlive many cases and is not one indefinitely running model loop. Pi stores task-internal reasoning progress in the Actor database. It does not replace the commercial ledger or customer-relationship records.

## Local development

From the repository root, install the pinned mise tools and workspace dependencies. Set a private token in the shell; do not commit its value or expose it in browser JavaScript.

```sh
mise install
mise exec -- pnpm install --frozen-lockfile
export OCCAVOY_RUNTIME_MODE=local
export OCCAVOY_RUNTIME_DEMO_TOKEN="$(openssl rand -hex 32)"
export DATABASE_URL="postgres://USER:PASSWORD@HOST:PORT/DATABASE"
mise exec -- pnpm --filter @occavoy/runtime dev
```

The local native SDK starts a development control plane at `http://localhost:6420`. The auxiliary HTTP listener is `http://127.0.0.1:8080/healthz`. Its response is process liveness only; it does not prove actor connectivity, durability, or cloud deployment. The `startServices:false` setting avoids starting unrelated services.

The token must be present in the verification shell too. A token changes authentication, not actor state. Keep local engine data outside a published repository; never commit credentials or local state.

## Meaningful verification

```sh
mise exec -- pnpm --filter @occavoy/runtime typecheck
mise exec -- pnpm --filter @occavoy/runtime test
mise exec -- pnpm --filter @occavoy/runtime verify:live
mise exec -- pnpm --filter @occavoy/runtime verify:restart
mise exec -- pnpm --filter @occavoy/runtime verify:harness
```

The automated SQLite tests cover accepted-command persistence after reopening a database, transactional rollback at the state/result boundary, duplicate/conflicting input, concurrent duplicate receipts, pause/resume, and fail-closed production configuration. When `DATABASE_URL` is present, the service-case tests additionally cover Postgres-backed supplier waiting, replacement-coordinator recovery, duplicate delivery, cancellation/revision fencing, pre-dispatch stale-task fencing, budget exhaustion, reconciliation lookup attribution, and follow-up case allowances. They do not substitute for the real Rivet integration check. `verify:restart` starts a local native runtime, prepares a paused case, replaces its process using SIGTERM, and resumes the same case. It generates an in-memory credential and temporary checkpoint, and requires no separately running development server. This proves neither abrupt-failure recovery nor Cloud operation.

Observed on **2026-11-27** with Node **26.13.1**, TypeScript **7.0.2** and RivetKit **3.1.1**: typecheck/build passed, all **10 runtime Node tests** passed with local Postgres, and the real local `verify:restart` check passed. The recovered `demoCase` retained its paused revision before continuing; duplicate application, conflicting command rejection and failed authentication were also checked. This legacy fixture checks SIGTERM replacement. The separate reasoning probe's SIGKILL evidence is described above. Docker image construction, Rivet Cloud deployment, machine loss, real provider side effects, production tenant isolation and backup restoration remain unverified.

With the runtime running, `verify:live` exercises the real actor, workflow wait, pause/resume, duplicate handling and unauthorized access. Its default mode does not claim a restart occurred. To check recovery across a runtime restart:

```sh
mise exec -- pnpm --filter @occavoy/runtime verify:live --prepare
# Stop and restart the runtime process, preserving local engine data and the token.
mise exec -- pnpm --filter @occavoy/runtime verify:live --resume
```

The checkpoint contains only a synthetic actor key and expected revision; no token. Run both commands from the same directory. By default verification permits only a local endpoint. Testing a remote isolated demo namespace additionally requires `OCCAVOY_VERIFY_REMOTE=1` and `OCCAVOY_RUNTIME_VERIFY_ENDPOINT`; this does not authorize deploying anything.

## Legacy command probe client API

The SDK API below is from the pinned 3.1.1 package. Keep this backend-only because it carries the demo credential.

```ts
import { createClient } from "rivetkit/client";
import type { RuntimeRegistry } from "./src/registry.js";

const client = createClient<RuntimeRegistry>("http://localhost:6420");
const handle = client.demoCase.getOrCreate(["qualification", "a-unique-key"], {
  params: { authToken: process.env.OCCAVOY_RUNTIME_DEMO_TOKEN },
});

await handle.pause("pause-command-id");
await handle.resume("resume-command-id");
await handle.submitInput("input-command-id", "Synthetic Hong Kong customer; global destination.");
const status = await handle.status();
```

Mutation responses mean durable command acceptance, not that the workflow has already applied the result. Read `status()` to inspect the snapshot and command outcomes. Reusing a command ID with different content is rejected. Submitting input while paused creates an explicit rejected result; resume, then submit a new command ID. Each fixture actor accepts at most 100 commands.

On wake, pending SQLite commands are notified again. Duplicate pending submissions also notify the workflow, closing the persisted-receipt-to-notification gap. Notifications trigger an ordered drain of accepted receipts, so transport arrival order does not define command order. This fixture uses `rivetkit/workflow` and the native queue interface available in 3.1.1. Those queue APIs are deprecated in that version; the rolling documentation uses a different package. Qualification of the supported successor is a commercial-pilot gate, not a silently accepted migration.

## Rivet Cloud hosted node

Cloud mode uses `runtime:"native"`, `startEngine:false`, and `startServices:false`. Rivet Cloud provides its own control plane and injects `RIVET_ENDPOINT`, `RIVET_TOKEN` and `RIVET_POOL`; do not override those variables on a hosted node. Set `OCCAVOY_RUNTIME_DEMO_TOKEN` as a private cluster secret. The Dockerfile sets `OCCAVOY_RUNTIME_MODE=cloud`, and production refuses an implicit local mode.

After a cluster and Docker access have been explicitly set up, the documented deployment path from the repository root is:

```sh
mise exec -- pnpm exec rivet login
mise exec -- pnpm exec rivet link --org ORGANIZATION --cluster CLUSTER
mise exec -- pnpm exec rivet deploy --dockerfile apps/runtime/Dockerfile --build-context .
```

These commands are instructions, not a record that deployment happened. The image builds with the workspace lockfile and `pnpm deploy --prod`. Public app liveness is `https://CLUSTER.onrivet.dev/healthz`; actor gateway/API is `https://CLUSTER-api.onrivet.dev`. Do not add automatic deploy-on-PR CI during bootstrap. A successful local test or Docker build does not prove cloud credentials, quotas, HA or recovery.

## Primary references

- [Pinned SQLite actor example](https://github.com/rivet-dev/rivet/blob/v3.1.1/examples/docs/actors-quickstart-backend/index.ts)
- [Pinned approval workflow example](https://github.com/rivet-dev/rivet/blob/v3.1.1/examples/docs/actors-workflows/approval-gate.ts)
- [Pinned authentication example](https://github.com/rivet-dev/rivet/blob/v3.1.1/examples/docs/actors-permissions/on-before-connect.ts)
- [Pinned CLI documentation](https://github.com/rivet-dev/rivet/blob/v3.1.1/docs/general/content/cli.mdx)
- [Current Rivet Cloud node deployment guide](https://rivet.dev/docs/deploy/cloud/compute/)
- [pnpm deploy](https://pnpm.io/cli/deploy)
