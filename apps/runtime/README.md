# Occavoy runtime qualification fixtures

This package contains two real Rivet 3.1.1 qualification fixtures with synthetic data, plus the initial production-shaped service-case slice:

- **`demoCase`** is the earlier command/workflow probe. It waits for client input, supports pause/resume, and prevents duplicate commands from applying twice. Its native queue API is deprecated and remains an isolated compatibility fixture.
- **`reasoningProbe`** uses the official `@rivet-dev/pi` adapter and Pi Durable inside an Actor. Its scripted model provider drives the actual model/tool loop and persisted tool tasks. It proves harness invocation and recovery without purchasing model calls.
- **`serviceCase`** is the deterministic case coordinator. Postgres is the authority for case state, commands, domain events, outbox intents, and usage; actor SQLite storage is limited to a recoverable drain schedule receipt.

Neither fixture books, charges, contacts a supplier, or creates a sandbox. The service-case slice does not invent inventory, supplier access, or verified prices. Actor-local demonstration records are not the production ServiceCase authority. Use synthetic text only. The test credentials are not production tenant authentication.

## Service-case authority slice

`serviceCase` uses supported Rivet actor actions and scheduling, not the legacy queue API. `PostgresCaseStore` can persist receipt alone; completing a command atomically records its decision and any business updates, events and outbox intents. The coordinator claims due outbox rows with database locking, starts bounded job adapters, requeues stale dispatch claims, and leaves supplier waiting as durable state rather than holding a model loop open. `DeterministicEffectDispatcher` exists in `packages/storage`; the default coordinator rejects `supplier_handoff` and requeues that intent rather than treating replay as a new submission.

`CaseJobAdapter` is the typed boundary for bounded reasoning jobs. Its immutable job specification carries tenant, case, task, request ID, base case revision, brief version, deadline, purpose, and tool profile. The Pi hook uses the `[tenantId, caseId, jobId]` actor key and must retry transport failures with the original request ID. Raw model output is never cast directly to a domain candidate: the adapter validates the candidate shape and exact job fence, then submits one `agent_candidate` command through Postgres. Cancellation aborts local work promptly and exposes an idempotent Pi cancellation hook; late candidates are still subject to the domain revision fence. The default host supplies neither a Pi invoker nor an RFQ sender. Coordinator tests inject runners; verify:harness exercises Pi separately. Without a sender the RFQ intent is requeued; it was not sent.

`PostgresUsageLedger` reserves model/tool usage before paid steps. Its counters are stored in `case_allowances`; every admitted or denied attempt is attributed in `case_usage_ledger` with a cost category. Only case-level exhaustion atomically pauses the case allowance with `budget_exhausted`; a per-task denial stops that task into `agent_intervention` (unless stale or inactive) without pausing the case. Case-level exhaustion blocks further discretionary paid work while still permitting controlled `reconciliation_lookup` attribution for existing unknown obligations. Closing a case closes only that case allowance, not the customer relationship.

The runtime build typechecks and then bundles the runtime with first-party workspace TypeScript into `dist` using esbuild. Versioned third-party runtime dependencies remain external, so the production image does not execute TypeScript sources from `node_modules`. The immutable storage migrations are copied beside `dist` because `applyMigrations` intentionally resolves them relative to the bundled module URL.

## Durable reasoning probe

For a case-backed recovery test rather than the standalone probe, run `mise exec -- pnpm verify:case-recovery` with the disposable Compose Postgres on port 54329. See the [HTTP activation to RFQ trace](../../docs/local-case-trace.md#local-pi-recovery-http-activation-to-rfq) for the process fault, measured usage and evidence boundaries.

To follow that same recovered case through a customer's return visit, exact approval and reconciliation of one synthetic booking, run `mise exec -- pnpm demo:london` in a terminal or `mise exec -- pnpm verify:london` unattended. The [London walkthrough](../../docs/london-saved-case.md) gives the fixture boundaries and expected checkpoints. Neither command mounts fixture routes or faults on the default server.

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

The crash test kills the owned runtime and its local engine, reopens their local data, and uses read-only status polling to observe recovery. It has no paid model calls and no external effects. It does not establish cloud recovery, disk-loss recovery, model quality, model pricing, or production transaction correctness. PostgreSQL persistence now exists in the service-case slice; connecting the probe to the production adapter through a host-injected invoker, real model access, and provider reconciliation remains separate work.

A long-lived ServiceCase coordinator and a bounded AgentTask are separate responsibilities. The intended task key is `[tenant, case, job]`; a customer relationship can outlive many cases and is not one indefinitely running model loop. Pi stores task-internal reasoning progress in the Actor database. It does not replace the commercial ledger or customer-relationship records.

## Local development

From the repository root, install the pinned mise tools and workspace dependencies, then refresh the local env snapshot. Never commit secret values or expose them in browser JavaScript.

```sh
mise install
mise exec -- pnpm install --frozen-lockfile
mise run secrets:refresh
mise exec -- pnpm --filter @occavoy/runtime dev
```

The `dev` script preloads the narrow local names from the ignored `.env.local` snapshot; see [docs/environment.md](../../docs/environment.md) for the refresh lane, the loader contract, and the shell-export fallback. A safe disposable `DATABASE_URL` target is the Compose Postgres fixture at `postgresql://127.0.0.1:54329/occavoy` with the public local-only `occavoy`/`occavoy` credentials.

The local native SDK starts a development control plane at `http://localhost:6420`. The auxiliary HTTP listener is `http://127.0.0.1:8080/healthz`. Its response is process liveness only; it does not prove actor connectivity, durability, or cloud deployment. The `startServices:false` setting avoids starting unrelated services.

Unlike `dev` and `test`, `verify:live` does not preload the snapshot: pass the same values explicitly (for example through `pnpm local:exec` from the repository root) so the verification shell shares the token. A token changes authentication, not actor state. Keep local engine data outside a published repository; never commit credentials or local state.

## Meaningful verification

```sh
mise exec -- pnpm --filter @occavoy/runtime typecheck
mise exec -- pnpm --filter @occavoy/runtime test
mise exec -- pnpm --filter @occavoy/runtime verify:live
mise exec -- pnpm --filter @occavoy/runtime verify:restart
mise exec -- pnpm --filter @occavoy/runtime verify:harness
```

The automated SQLite tests cover accepted-command persistence after reopening a database, transactional rollback at the state/result boundary, duplicate/conflicting input, concurrent duplicate receipts, pause/resume, and fail-closed production configuration. When `OCCAVOY_TEST_DATABASE_URL` explicitly selects the disposable Compose fixture, the service-case tests additionally cover Postgres-backed supplier waiting, replacement-coordinator recovery, duplicate delivery, cancellation/revision fencing, pre-dispatch stale-task fencing, budget exhaustion, reconciliation lookup attribution, and follow-up case allowances. They do not substitute for the real Rivet integration check. `verify:restart` starts a local native runtime, prepares a paused case, replaces its process using SIGTERM, and resumes the same case. It generates an in-memory credential and temporary checkpoint, and requires no separately running development server. This proves neither abrupt-failure recovery nor Cloud operation.

Current dated evidence is indexed in the [implementation handoff](../../docs/implementation-handoff.md#starting-evidence). Earlier, on **2026-11-27** with Node **26.13.1**, TypeScript **7.0.2** and RivetKit **3.1.1**: typecheck/build passed and the real local `verify:restart` check passed. The recovered `demoCase` retained its paused revision before continuing; duplicate application, conflicting command rejection and failed authentication were also checked. This legacy fixture checks SIGTERM replacement. The separate reasoning probe's SIGKILL evidence is described above. Docker image construction, Rivet Cloud deployment, machine loss, real provider side effects, production tenant isolation and backup restoration remain unverified.

With the runtime running, `verify:live` exercises the real actor, workflow wait, pause/resume, duplicate handling and unauthorized access. Its default mode does not claim a restart occurred. To check recovery across a runtime restart:

```sh
mise exec -- pnpm --filter @occavoy/runtime verify:live --prepare
# Stop and restart the runtime process, preserving local engine data and the token.
mise exec -- pnpm --filter @occavoy/runtime verify:live --resume
```

The private checkpoint records the resolved actor ID and expected paused revision, not a token. Use the same directory for both phases and a fresh checkpoint path for each run (`OCCAVOY_RUNTIME_CHECKPOINT`). Resume addresses that ID without creating an actor. This verifier uses the standard local engine credentials and accepts only a plain loopback HTTP origin; the former remote opt-in is not supported.

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

The production image omits the local engine CLI and development services; use the workspace for local engine runs. In cloud mode the runtime serves Prometheus metrics at `http://127.0.0.1:9464/metrics` inside the container. Set `RIVETKIT_METRICS_PORT` only if a different port is needed. Keep it distinct from `PORT` and other listeners; a bind collision stops startup. Scraping from inside the container does not prove that a hosted collector can reach it.

### Private dev checkpoint (OCA-2)

[OCA-2](https://linear.app/tianjis/issue/OCA-2) is a hosted qualification, not a deployment recipe. Local image construction, a ready build and `/healthz` are not a checkpoint. Do not run local verification drivers against Cloud.

Before any hosted write, the owners must supply or confirm:

- A read-only delivery scoped to Doppler `occavoy/dev`, through the approved secret channel. Bind only the named settings needed by each process. No whole-config export, broad fallback, copied snapshot, secret in argv or inherited `OPENAI_*` in a synthetic run.
- Keep the permanent Prisma Postgres dev binding (`occavoy/dev:DATABASE_URL`) scoped to approved application use. It was rebound through the dedicated write token and verified through the separate read-only token without printing its value. The dev schema was migrated through migration version `007_outbox_dispatched_index`; direct application probes confirmed connection identity, TLS on the client hop, advisory-lock migration idempotence, quota transactionality, attempt fencing, case-job scoping, intervention records, outbox ordering and concurrent initializer behavior. This does not make it a disposable test target. Ordinary database tests still require an explicit Compose-owned `OCCAVOY_TEST_DATABASE_URL`. The minimal `demoCase` checkpoint uses actor SQLite and does not need this binding injected.
- The private ingress and explicit organization, cluster, region and dedicated non-default pool, the exact image revision, resource limits, secret references and a bounded replacement/cleanup plan. Prove actor creation and worker placement are confined to that pool; a CLI deployment target alone is insufficient. Stop on an unknown or default route. Obtain approval for the exact operations, including actor creation, credential issuance if needed, and replacing just the probe worker. The pinned 3.1.1 cluster rollout currently rejects every non-default runner-pool name with “only the `default` runner pool is supported for now.” Therefore the OCA-2 hosted gate cannot be satisfied on this Rivet Cloud cluster as configured; do not use `default` as a substitute. A ready uploaded build by itself is not qualification and does not create a runner, actor or checkpoint.
- Separate gateway and actor authentication. For the pinned [3.1.1 gateway](https://github.com/rivet-dev/rivet/blob/v3.1.1/docs/api/content/authentication.mdx), use a backend client with a short-lived `actor_gateway:read` grant on the exact actor ID after authorized creation. That grant allows actor actions; it does not grant creation by key or replace the `authToken` connection parameter checked by `demoCase`. Confirm how the client receives its grant without reusing a node or control-plane secret. Use secret references for deployment, never literal secret values.

Once approved, start one synthetic `demoCase` in the dedicated pool. Wait for `awaiting_input`, pause and read the committed paused revision 1. Record the real actor ID privately. Confirm replacement of the serving worker from the platform, then reconnect **by that same ID**, not `getOrCreate`. Require the same paused state before resume, `client_input` at revision 2, and one synthetic input applied at revision 3. A duplicate must not advance the revision. Check missing/invalid gateway access separately from a valid gateway credential with a wrong actor token: require explicit authorization denials and a successful authorized read, not a generic network failure. Keep raw IDs and logs private; report equality, build revision, observed transitions and redacted results only. Stop at this gate.

The [London replay](../../docs/london-saved-case.md) needs a separate private synthetic host: the standard registry has no Pi invoker or `caseJob`. Keep the Compose/loopback driver local; do not expose fixture controls. Use the isolated Postgres ledger, faux model and fake supplier, and match the local counters there before considering one separately approved, capped candidate-only inference task. No real supplier, charge or booking.

## Primary references

- [Pinned SQLite actor example](https://github.com/rivet-dev/rivet/blob/v3.1.1/examples/docs/actors-quickstart-backend/index.ts)
- [Pinned approval workflow example](https://github.com/rivet-dev/rivet/blob/v3.1.1/examples/docs/actors-workflows/approval-gate.ts)
- [Pinned authentication example](https://github.com/rivet-dev/rivet/blob/v3.1.1/examples/docs/actors-permissions/on-before-connect.ts)
- [Pinned CLI documentation](https://github.com/rivet-dev/rivet/blob/v3.1.1/docs/general/content/cli.mdx)
- [Current Rivet Cloud node deployment guide](https://rivet.dev/docs/deploy/cloud/compute/)
- [pnpm deploy](https://pnpm.io/cli/deploy)
