# ADR 0005: Qualify Pi Durable on Rivet for service-agent work

Status: selected PoC candidate; local scripted-provider qualification passed on 27 November 2026. Cloud deployment and production acceptance remain open.

Research date: 27 November 2026. Versions below describe the packages inspected on this date,
not a policy to follow a moving `latest` tag.

## Decision

Qualify the official `@rivet-dev/pi` adapter before writing a custom durable wrapper around a
plain agent loop. The initial combination is:

| Component                           | Exact qualification version | Reason                                                        |
| ----------------------------------- | --------------------------- | ------------------------------------------------------------- |
| Rivet runtime and SDK               | `3.1.1`                     | Existing project baseline                                     |
| Rivet Pi adapter                    | `@rivet-dev/pi@0.5.7`       | Published official integration                                |
| Pi Durable and matching Pi packages | `1.5.2`                     | Latest published `1.5.x` patch satisfying the adapter's peers |

The adapter declares `rivetkit >=2.3.28 <2.4.0 || ^3.0.0` and `~1.5.0` peers for
`@earendil-works/pi-durable`, `pi-ai`, `pi-telemetry`, and `chord`; its coding-agent dependency
also uses `~1.5.0`. Upstream Pi `1.6.1` is newer but outside that declared compatibility range.
Do not override the peer check to combine them. Record exact direct pins and the complete
resolution in the workspace manifests and lockfile. [Adapter metadata][pi-package] ·
[Compatible Pi metadata][pi-compatible] · [Upstream metadata][pi-current]

This is a bounded qualification, not a claim that the adapter is already
production ready. Pi Durable is documented as beta. The production harness choice is independent
of which coding agent a contributor uses to develop Occavoy. [Official integration][pi-guide]

## Ownership and composition

Two durable scopes are useful and may share the same Rivet infrastructure:

- **Service case controller:** owns business progress, supplier waits, deadlines, approved
  expenditure, cancellation, reconciliation, and the next allowed action.
- **Agent task:** owns the conversation, model/tool progress, and recoverable execution of one
  assigned piece of work. Its output is evidence or a proposed command for the case controller.

The controller can outlive many agent tasks. A customer relationship can outlive many service
cases. Neither requires keeping one model turn running indefinitely. Store authorized reusable
preferences and commercial records independently of a harness transcript.

Use a stable tenant, case, task, and submission mapping. Derive tenant scope from authenticated
server context, not a model argument or an unverified actor key. Give tasks a requirement revision,
deadline, allowed tools, and an execution allowance. Bound each run and the total number of
continuations; a new conversation or continuation must not reset the case's spending allowance.

The first topology keeps the harness in the Rivet Node application. Cloudflare Workers is the
target for authenticated web requests and returns a durable operation reference rather than
holding the request open; that authenticated boundary is not yet wired. Postgres remains the intended authority for quotes, approvals, external actions,
orders, and costs. Pi's Actor database is execution state, not another commercial ledger.
See [ADR 0002](0002-business-truth-and-effects.md).

Restate remains an optional self-hosted component for a separately demonstrated need. A second
durable scope does not automatically require another engine, and no two controllers may own the
same operation. See [ADR 0001](0001-stack-and-runtime.md).

## Actual integration surfaces

The options are libraries and service interfaces, not just terminal applications.

| Option                                          | Invocation and embedding                                                                                                                                                                                                                    | State and deployment                                                                                                                                                                             | Current qualification consequence                                                                                                                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi Durable with the official Rivet adapter      | Define `pi({ models, tools, ... })`; register the Actor with Rivet. Typed `rivetkit/client` actions or gateway HTTP invoke `submit`, `prompt`, conversation and submission methods.                                                         | Pi stores execution in its Actor's SQLite database. Runs in the existing Node runtime; shell access requires an explicit sandbox.                                                                | Smallest currently identified official integration with the chosen runtime. The pinned pair passes the local qualification; Cloud and commercial acceptance remain open.                                   |
| Eve                                             | `defineAgent`; `eve/client` calls an HTTP service with NDJSON streams. `client.sessions.create({ message })`, `session.send(...)`, and `delivery.result()` are current client APIs. CLI and framework integrations are additional surfaces. | Eve owns its session lifecycle on a Workflow World. Self-hosted Node/Nitro and custom Worlds are supported; a sandbox and Vercel AI Gateway are optional. Rivet supplies an official beta World. | Credible alternative when its session, channel, approval, and subagent facilities reduce application work. The current published package combination has a specific compatibility problem described below. |
| fx / `libfx`                                    | `createFxAgent(...).session(...).prompt(...)` provides durable sessions. `createFxEngine({ persistence })` exposes a lower-level conversation journal. CLI `fx ask --json` and stdio ACP are separate interfaces.                           | Native Node addon or WASM; local files, Vercel World, custom World, or host-owned persistence. Custom tool functions run under host policy.                                                      | A legitimate embeddable alternative. It would require qualifying an additional persistence/runtime integration rather than assuming CLI resume is sufficient.                                              |
| Plain Pi, with Nod as an implementation example | Pi can be embedded in a backend. Nod wraps Pi sessions with its own application runtime, tools, policy, queues, and saved records.                                                                                                          | Nod uses PostgreSQL and pg-boss around its Pi sessions; its documented turn policy never retries a turn.                                                                                         | Demonstrates that an embedded harness can support a service, but also exposes the surrounding application work. It does not establish plain Pi as equivalent to Pi Durable.                                |

Sources: [Pi actions and behavior][pi-guide], [published adapter source][pi-source],
[Eve client][eve-client], [Eve self-hosting][eve-selfhost], [libfx API][fx-api],
[fx command interface][fx-cli], [fx ACP][fx-acp], [Nod architecture][nod-architecture].

For Pi, use `submit(text, { requestId })` and persist the returned `submissionId`; observe the
submission with `submission.status(...)`, a bounded wait, or conversation events. Reuse the
same request ID after a lost acknowledgement. `prompt` is a convenient waiting interface, but
its timeout or client disconnection does not stop the run. Explicit abort is separate. These
interfaces are present in the inspected `0.5.7` package's `dist/actions.js` and declarations.
[Package and source][pi-package]

## Compatibility findings for the alternatives

### Eve on Rivet is supported in principle, with a current package mismatch

Eve `1.0` became generally available on 17 November; the inspected current package is `1.5.0`.
Eve's server, Workflow persistence, model routing, and sandbox are separate choices. It is
incorrect to describe Eve as requiring Vercel hosting. [GA announcement][eve-ga] ·
[Versioned package][eve-package] · [Self-hosting][eve-selfhost]

Rivet's official beta `@rivet-dev/workflow-world` stores workflow execution in Rivet Actors.
The Workflow HTTP process starts the registry lazily. It requires a long-lived process, a
reachable workflow callback URL, and authenticated dispatch when exposed publicly. It does
not require a second managed Workflow service. The documented `@rivet-dev/agentos-eve`
sandbox adapter is an additional choice, not the durability backend itself.
[Rivet World][rivet-world-guide] · [Eve integration][rivet-eve-guide]

However, the published stable pair cannot be accepted solely from that rolling tutorial:

- `eve@1.5.0` checks `world.capabilities?.atomicStartHook?.active === true` before starting
  a session. The check is in its published `dist/src/internal/workflow/start-claim.js`.
- The inspected `@rivet-dev/workflow-world@3.1.1` package contains no declaration or
  implementation of that capability. Its dependencies include `@workflow/world@5.0.0-beta.21`.
- This is a source-level compatibility blocker for that exact pair, not a runtime experiment
  proving that every Eve/Rivet combination fails. Resolve it through a supported, pinned adapter
  combination and a real session-start/recovery test; do not suppress Eve's capability check.

The package metadata links the inspected published archives. Rivet World records package
`gitHead` `319e4d2940089bc6db42d2f99c6d83dcd33aaa3a`.
[Eve package][eve-package] · [Rivet World package][rivet-world-package] ·
[Required World capabilities][eve-worlds]

Upgrade behavior also matters for long-lived customers. Eve documents that self-hosted local
and Postgres sessions survive a rebuild of the same Eve version but cannot resume after an
Eve version change. Vercel's deployment routing has different behavior. A Rivet World deployment
needs an explicit upgrade qualification; retaining a transcript is not equivalent to retaining
pending approvals and task state. [World comparison][eve-worlds] · [Execution model][eve-execution]

### fx is an experimental SDK with real durability surfaces

The inspected `libfx` package is `0.0.18`. Its documentation explicitly allows breaking changes
within `0.0.x`, including stored formats. Native Linux builds require the appropriate addon
and glibc 2.34 or newer. WASM requires JSPI; browser support does not by itself prove compatibility
with Cloudflare Workers. Keep the candidate on Node until that target is tested.
[Versioned package][fx-package] · [Stability][fx-stability] · [Node runtime][fx-node]

`createFxAgent` supports a supplied Workflow World. In ordinary Node it otherwise defaults to
local files, potentially under a temporary directory. `createFxEngine` accepts a host-owned
journal with compare-and-swap appends, durability barriers, and ambiguous-tool recovery. Either
could be qualified with Rivet, but neither establishes an already-tested Rivet adapter.
[Durability][fx-durability] · [Persistence contract][fx-checkpoints]

The current API reserves a `max_model_turns` stop reason but states that libfx sets no model-step
limit. A service integration must implement its allowance and stopping policy. Session IDs are
not authorization, and CLI permission prompts do not apply to SDK tools. Custom tools must
validate inputs and enforce tenant, approval, and external-action policy in the host.
[API][fx-api] · [Tools][fx-tools]

## Application responsibilities under every harness

1. **Approval is a business record.** Bind approver, proposal revision, scope, amount, currency,
   and expiry. Recheck at dispatch. A tool approval dialog or model decision is insufficient.
   Eve has durable approval policies; Pi requires application tool gating. Neither provides
   exactly-once external transactions. [Eve approvals][eve-approval] · [Pi approval pattern][pi-approval]
2. **Unknown external results remain unknown.** Persist a stable action ID and approved request
   before dispatch. If a supplier accepts an action and the response is lost, query by reference
   or require reconciliation. Never replay a purchase merely because the harness resumes.
3. **Tool replay is explicit.** Mark only genuinely safe operations as replayable. Finished
   results can be reused; interrupted effects need provider idempotency or status lookup.
   A model may propose the same action again with a new tool-call ID, so deduplication must use
   the business operation ID. [Pi custom tools][pi-tools] · [Eve recovery][eve-execution] ·
   [fx tool recovery][fx-durability]
4. **Streaming is a view.** A lost fragment does not change the business result. Persist command
   acceptance and result delivery; reconnect by cursor or snapshot. Pi's `onAnswer` can run again
   after interruption, so customer notifications need their own deduplicated outbox.
5. **Isolation and budgets are host policy.** Enforce tenant access at every route and tool,
   reserve usage before calls, bound concurrency and continuation, keep credentials out of tool
   results, and distinguish cancellation from reversal. Source text is untrusted input.

Sandbox access remains disabled for the initial bounded service tools. Choosing a harness does
not choose a shell, browser, or model subscription. Apply [ADR 0004](0004-storage-and-sandbox-boundaries.md)
when an actual task requires isolation.

## Qualification gates and known Pi limits

Run the first check with a deterministic local model provider and synthetic tools, exercising
the real published harness and Rivet runtime without paid inference. A mocked wrapper alone
does not establish that the adapter starts or persists. Record observed results in the runtime
handoff; a local pass does not complete the broader gates below or establish a cloud deployment.

The checked-in [runtime qualification](../../apps/runtime/README.md) passed locally: actual
model/tool turns with a scripted provider against the real Pi adapter, submission deduplication,
actor-scope isolation, persisted attempt limits, a turn limit, deadline handling, and
process-kill recovery for safe and unsafe tools. Separately, the Postgres case store,
coordinator, usage ledger, effect dispatcher and quota ledger pass real-PG local tests. These
are distinct proofs; their production wiring, the missing production host invoker, paid
inference, Cloud recovery, provider integration and upgrade qualification are still open.

| Gate                           | Required evidence                                                                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Package/API compatibility      | Exact pins install without peer overrides; actual Actor accepts a submission and returns a durable result                                 |
| Recovery                       | Replace the process during a model call, a safe tool, and a wait; the same task recovers without duplicating a committed business effect  |
| Approval and uncertain outcome | Expired/revoked approval blocks dispatch; a lost external response enters reconciliation; a new model call cannot bypass that state       |
| Concurrency and cancellation   | Duplicate submission IDs, late results, two tenant identities, aborted work, and a detached client preserve the expected case revision    |
| Resource bounds                | A looping model, continuation, tool timeout, and excessive output stop or pause under a persisted allowance                               |
| Deployment and upgrade         | The chosen Rivet Cloud Node image passes recovery and authenticated access checks; schema changes have a tested roll-forward/restore plan |

Pi's documented limitations include application-owned approvals, no shell without a sandbox,
plain interrupted tools not automatically replayed, repeated interrupted model requests, and
roll-forward-only durable schemas. Streaming can lose roughly the final second of partial
output on a crash. Tools must honor abort signals; a timed-out action wait can leave its run
active. These are qualification inputs, not reasons to conflate a saved conversation with a
completed service. [Pi limitations][pi-guide]

## Revisit criteria

Reopen this ADR if the official Pi adapter fails a required recovery/isolation/budget gate,
requires maintaining a substantive fork, or its compatibility lag blocks a required capability.
Also reconsider Eve when its published Rivet World satisfies the required capabilities and a
measured implementation using Eve removes enough channel/session/approval work to justify the
integration. Reconsider fx when a bounded native or WASM workload has a demonstrated benefit and
its storage/upgrade and host-policy tests pass.

Compare the same synthetic service case, fault points, output quality, human intervention,
measured engineering effort, provider usage, and operation cost. Do not select by a generic
feature score or a coding benchmark unrelated to service delivery. Keep business commands and
results independent of vendor conversation formats so a later change does not migrate the
commercial ledger or rewrite supplier contracts.

[pi-package]: https://registry.npmjs.org/@rivet-dev%2fpi/0.5.7
[pi-compatible]: https://registry.npmjs.org/@earendil-works%2fpi-durable/1.5.2
[pi-current]: https://registry.npmjs.org/@earendil-works%2fpi-durable/1.6.1
[pi-source]: https://github.com/rivet-dev/agents/blob/main/packages/pi/src/actions.ts
[pi-guide]: https://rivet.dev/ecosystem/pi-durable/
[pi-approval]: https://rivet.dev/guides/agent-human-in-the-loop/
[pi-tools]: https://rivet.dev/guides/agent-custom-tools/
[eve-ga]: https://vercel.com/blog/eve-is-now-generally-available
[eve-package]: https://registry.npmjs.org/eve/1.5.0
[eve-client]: https://eve.dev/docs/guides/client
[eve-selfhost]: https://eve.dev/docs/guides/deployment/self-hosting
[eve-worlds]: https://eve.dev/docs/guides/deployment/workflow-worlds
[eve-execution]: https://eve.dev/docs/concepts/execution-model-and-durability
[eve-approval]: https://eve.dev/docs/human-in-the-loop
[rivet-eve-guide]: https://rivet.dev/ecosystem/vercel-eve/
[rivet-world-guide]: https://rivet.dev/ecosystem/vercel-workflows-sdk/
[rivet-world-package]: https://registry.npmjs.org/@rivet-dev%2fworkflow-world/3.1.1
[fx-package]: https://registry.npmjs.org/libfx/0.0.18
[fx-api]: https://fx.sh/docs/lib/api
[fx-cli]: https://fx.sh/docs/using-fx/fx-ask
[fx-acp]: https://fx.sh/docs/using-fx/acp
[fx-stability]: https://fx.sh/docs/stability
[fx-node]: https://fx.sh/docs/lib/node
[fx-durability]: https://fx.sh/docs/lib/durability
[fx-checkpoints]: https://fx.sh/docs/lib/checkpoints
[fx-tools]: https://fx.sh/docs/lib/tools
[nod-architecture]: https://nod.n8n.io/docs/how-it-works/architecture/
