# Occavoy runtime qualification fixture

This package is a small, real Rivet 3.1.1 actor/workflow integration. It stores a synthetic case and accepted commands in actor SQLite, waits durably for client input, supports pause/resume, and prevents duplicate commands from applying twice.

It does **not** book, charge, call a model, contact a supplier, or create a sandbox. Actor-local demonstration state is not the production ServiceCase authority: production business records remain in Postgres. Use synthetic text only. The shared demo token is a test boundary, not tenant authentication.

## Local development

From the repository root, install the pinned mise tools and workspace dependencies. Set a private token in the shell; do not commit its value or expose it in browser JavaScript.

```sh
mise install
mise exec -- pnpm install --frozen-lockfile
export OCCAVOY_RUNTIME_MODE=local
export OCCAVOY_RUNTIME_DEMO_TOKEN="$(openssl rand -hex 32)"
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
```

The automated SQLite tests cover accepted-command persistence after reopening a database, transactional rollback at the state/result boundary, duplicate/conflicting input, concurrent duplicate receipts, pause/resume, and fail-closed production configuration. They do not substitute for the real Rivet integration check. `verify:restart` starts a local native runtime, prepares a paused case, replaces its process using SIGTERM, and resumes the same case. It generates an in-memory credential and temporary checkpoint, and requires no separately running development server. This proves neither abrupt-failure recovery nor Cloud operation.

Observed on **2026-11-27** with Node **26.13.1**, TypeScript **7.0.2** and RivetKit **3.1.1**: typecheck/build passed, all **5 SQLite tests** passed, and the real local `verify:restart` check passed. The recovered case retained its paused revision before continuing; duplicate application, conflicting command rejection and failed authentication were also checked. Docker image construction and Rivet Cloud deployment have **not** been tested in this bootstrap. SIGKILL, machine loss, provider side effects, tenant isolation and backup restoration remain separate qualification work.

With the runtime running, `verify:live` exercises the real actor, workflow wait, pause/resume, duplicate handling and unauthorized access. Its default mode does not claim a restart occurred. To check recovery across a runtime restart:

```sh
mise exec -- pnpm --filter @occavoy/runtime verify:live --prepare
# Stop and restart the runtime process, preserving local engine data and the token.
mise exec -- pnpm --filter @occavoy/runtime verify:live --resume
```

The checkpoint contains only a synthetic actor key and expected revision; no token. Run both commands from the same directory. By default verification permits only a local endpoint. Testing a remote isolated demo namespace additionally requires `OCCAVOY_VERIFY_REMOTE=1` and `OCCAVOY_RUNTIME_VERIFY_ENDPOINT`; this does not authorize deploying anything.

## Client API

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
