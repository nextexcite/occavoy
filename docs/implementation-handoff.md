# Engineering handoff: one durable customer case

Read [AGENTS.md](../AGENTS.md), [agent execution](agent-execution.md), [ADR 0005](adr/0005-agent-harness.md), the current code and the assigned Linear issue before editing. This is a concrete implementation sequence, not a claim that all listed modules exist.

## Starting evidence

Evidence frozen at merge commit `6112523`: [passing CI](https://github.com/nextexcite/occavoy/actions/runs/45982258175/job/140448854845) ran on `103e61c`, whose tree is identical to `6112523` — 76 Vitest tests, 21 runtime Node tests, 7 Python tests, both local restart harnesses, 0 paid model calls and 0 external effects in the Pi probe. No cloud deployment, supplier, or customer is involved. The startup recipe for these checks is in [development.md](development.md) and the CI workflow.

| Surface | Local proof | Missing / not established |
| --- | --- | --- |
| Web | `apps/web` preview screens render local data | Nothing is saved; no verified customer or partner identity; no case submission |
| Case store | [`packages/storage/src/postgres-case-store.ts`](../packages/storage/src/postgres-case-store.ts): scoped command ID/payload-hash deduplication and case revision CAS, domain events, outbox intents, immutable quote/proposal/approval versions — tested in [`packages/storage/test/postgres-case-store.test.ts`](../packages/storage/test/postgres-case-store.test.ts) | No HTTP boundary or authentication in front of it |
| Case coordinator | `serviceCase` in [`apps/runtime/src/service-case.ts`](../apps/runtime/src/service-case.ts): outbox leases, drain, scheduling, stale-RFQ and cancellation fencing, agent-task stop before acknowledgement — tested in [`apps/runtime/test/service-case.test.mjs`](../apps/runtime/test/service-case.test.mjs) | No production delivery transport or wired create/activate API |
| Usage limits | [`packages/storage/src/postgres-usage-ledger.ts`](../packages/storage/src/postgres-usage-ledger.ts): per-task and per-case running limits; a per-task denial does not pause the case | No paid-model pricing or monetary settlement |
| Job adapter | The [case-job adapter](../apps/runtime/src/case-job-adapter.ts) validates the job fence with injected runners in [coordinator tests](../apps/runtime/test/service-case.test.mjs). Separately, the [Pi harness](../apps/runtime/test/verify-harness.mjs) runs a real Pi Durable loop with a scripted provider. | No invocation connects these two proofs in the default host. |
| Effect dispatch | [`packages/storage/src/effect-dispatcher.ts`](../packages/storage/src/effect-dispatcher.ts) on real Postgres with the synthetic in-memory [`FakeSupplierAdapter`](../packages/storage/src/fake-supplier.ts) under the same live fixture | No cross-provider restart, no real supplier, `supplier_handoff` not yet wired to the coordinator |
| Quota ledger | [`packages/storage/src/postgres-quota-ledger.ts`](../packages/storage/src/postgres-quota-ledger.ts): singleton 8,000,000,000-byte budget, quarantines oversized observations, serializes admission against quarantine writes | No real R2 inventory reconciliation; uploads remain disabled |
| Identity and grants | The reducer checks caller-supplied tenant, case, permission, expiry and actor/grant context; tests supply synthetic authority. | Not implemented as public authentication; no grant resolution or grant store |

Use actual test output and the issue record for the latest verification result. Do not change an issue to Done merely because an interface or fixture exists.

## First integrated scenario

Use one synthetic Hong Kong customer, a London performance, a two-person brief, and one hotel supplier response. All money and provider records are fixtures. A second destination must use the same path without changing the state machine.

Acceptance sequence:

1. Save an occasion without starting a case or a model call.
2. Activate the case through an authenticated command. Commit the command and outbox together and return its receipt.
3. Start a bounded requirements job with a stable `jobId`/`requestId` and a recorded case revision. Show an actual Pi model/tool loop using the scripted provider first.
4. Turn its validated result into a supplier request. Persist a waiting reason; no model remains running while waiting for the supplier.
5. Restart the application. Submit the same command again. Neither the job nor the supplier request may be duplicated.
6. Enter a structured synthetic quote through the operator path. Produce an immutable proposal from the quote, with seller, fulfiller, currency, amount, terms, scope and expiry.
7. Revise the brief or proposal once. Prove that an earlier agent result and an earlier approval are rejected.
8. Approve the current proposal. Simulate the supplier accepting the action while its response is lost. The action becomes `unknown`; a repeated dispatch is blocked.
9. Resolve that uncertainty through a simulated provider lookup under the original reference. Record booking, payment and fulfilment observations independently.
10. Close the case with evidence. Start a new case under the same customer relationship; do not reuse the old approval.

The sequence requires an operator form and a case timeline, not a map, voice UI, many agents, or autonomous browser purchasing.

## Work order and file boundaries

The durable foundation rows below are locally proven; the remaining work reuses them rather than adding parallel structures. The labels do not mark any Linear issue accepted. Case creation and activation are separate store APIs today — an atomic create-plus-activation HTTP route is a target, not an existing path.

| Order | Linear work | Reuse | Concrete remaining gates |
| --- | --- | --- | --- |
| 1 | OCA-33 qualification and OCA-2 Cloud | Preserve the tested compatible dependency tuple; `verify:harness` passes locally | Deploy the actual image to Rivet Cloud; model/tool loop, duplicate request, interrupted work and tenant boundary checked on the intended build |
| 2 | OCA-4 (local store) | `PostgresCaseStore` command + outbox + result transaction, version CAS, immutable records | Scoped authenticated HTTP boundary: `receiveCommand` persists a receipt only — completion outbox versus receive receipt must stay distinct; no model work inside the request; atomic create+activate route |
| 3 | OCA-5 and OCA-7 (local slices) | `serviceCase` coordinator, case-to-job adapter, atomic outbox claim, due-case scheduling, job/case allowances | Real Pi loop through a host-injected invoker with a stable request ID; production adapter wiring |
| 4 | OCA-6 (synthetic supplier) | `DeterministicEffectDispatcher` and fake supplier fixture | Wire `supplier_handoff` recovery to the existing dispatcher. **A replayed intent is not permission to send**: only a fresh dispatch transaction may send. Positive lookup under the original reference; a negative retry needs a durable fence of the exact attempt plus fresh terminal evidence and rechecked terms. If proof is absent, stay `unknown` — do not close or rebook |
| 5 | OCA-9 through OCA-14, narrow subset | Domain lifecycle and store contracts | Synthetic RFQ/response, manual operator path and timeline connecting sourced/fixture event → brief → requirements → quote → proposal |
| 6 | OCA-15 through OCA-17 | Same persisted contracts | Connect the three customer areas and operator exception path; refresh/reconnect preserves state; the UI shows waiting, stale approval and unknown outcomes accurately |

The week-2 milestone covers the **narrow integrated scenario**, including a minimal subset of the later business work. Full catalog, partner access controls, polished customer interaction and broader supply remain week-4/pilot work. Do not wait until week 4 to discover that the runtime cannot complete a case.

[OCA-33](https://linear.app/tianjis/issue/OCA-33) tracks the local harness qualification. [OCA-34](https://linear.app/tianjis/issue/OCA-34) is the integrated case acceptance gate across the implementation issues above. The gate does not mark those implementations complete or duplicate their work estimates.

## Required application contracts

These are application-level API targets, not claims that these routes already exist. Keep transport code thin and enforce the same rules in the domain/repository boundary.

| Entry point                             | Input and trusted context                                                   | Durable result                                                               |
| --------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `POST /api/cases`                       | Authenticated principal; explicit activation; brief and client command ID   | Case, command receipt and outbox in one transaction (target: atomic create+activation; today they are separate store calls) |
| `POST /api/cases/:id/commands`          | Principal and tenant from auth; command ID; expected version; typed payload | Accepted or rejected receipt; an identical retry returns the earlier receipt |
| `GET /api/cases/:id`                    | Authorized case access                                                      | Current version, phase, waiting reason and public decision state             |
| `GET /api/cases/:id/timeline?after=...` | Authorized case access and cursor                                           | Persisted ordered events; streaming may deliver additional notifications     |
| `POST /api/supplier-responses`          | Authenticated/signed partner identity; RFQ/version; stable response ID      | Validated observation, deduplication and a case wake command                 |

Approval is a typed command through the same boundary, not a free-text chat acknowledgement. Derive the approving actor and permitted scope from verified identity/grants. An approval must bind the immutable proposal version/hash, exact authorized amount and currency, action scope, and expiry.

An agent-job specification is defined by the checked-in [`apps/runtime/src/case-job-adapter.ts`](../apps/runtime/src/case-job-adapter.ts), not a sketch: the caller allocates `taskId` (which maps to the actor key's third component), `requestId` (stable across transport retries), `baseRevision` (the case revision fence), `briefVersion` (carried in job input and result, fenced before applying a candidate), purpose, tool profile, deadline and allowance. A changed brief or a new reasoning objective gets a new job. Use durable completion lookup under the original job when a reply is lost.

The actor probe alone cannot generate a trusted commercial record: its signed fixture input is not the production authentication, authorization or business-result validation boundary, and the host invoker connecting the adapter to a production Pi actor is still missing. Do not cast a probe result to `AgentTaskCandidate`.

## Persistence responsibilities

Before introducing a new state store, explain which existing owner cannot hold the record:

- Postgres: relationships/grants, cases, brief revisions, commands/results, outbox, jobs and allowances, RFQs, quote/proposal revisions, approvals, effects, order/payment/fulfilment observations and timeline events. Command rows already persist actor and grant IDs as evidence references, but grant resolution and a grant store are not implemented; not every target record needs its own table today.
- Case actor SQLite: a recoverable drain schedule receipt and execution references. It cannot overwrite a newer Postgres business revision.
- Pi actor SQLite: conversation, model/tool checkpoints and submission deduplication for the scoped agent job. Do not put this in an ordinary container-local file.
- R2: bounded evidence objects through the quota ledger. Never use object existence alone as proof of a commercial outcome.

Required database constraints include unique tenant/command ID, tenant-scoped unique action ID and client reference (the supplier reference is nullable until confirmed), payload-hash conflict checks, immutable proposal versions, and conditional case-version updates. The transport may be retried; the transaction must decide whether work is new, already applied, stale, or unresolved.

## Version and framework rules

The selected Rivet adapter currently requires the Pi 1.5 family. Do not replace those pins with upstream Pi 1.6 simply because it is newer. Qualify an adapter upgrade as a tuple, including forward schema migration and an interrupted in-flight job.

The earlier `demoCase` uses the deprecated Rivet queue/workflow APIs. It is retained as a labelled legacy restart proof, not a template for the service coordinator. Use supported actions plus a durable inbox/drain and scheduling for the coordinator, or qualify the separately versioned `@rivet-dev/workflows` package in an ADR if its primitives actually simplify the case. Never silently copy rolling workflow examples into the deprecated API.

Do not install Eve, fx, Restate, a sandbox, another queue, or another state-machine framework just to fill a diagram. The selected job adapter can be replaced when a measured requirement justifies it. A second durability scope is allowed; two authorities for the same business record are not.

## Definition of the next useful result

A reviewable next result is one accepted case that can pause for input, survive a restart, receive a supplier response, enforce current approval and preserve an uncertain supplier outcome. Report the commit, exact commands, environment, observed state transitions, failed scenarios, active engineering time and remaining blockers. The runnable startup recipe is in [development.md](development.md) and the CI workflow.

Keep cloud, paid-model and real-supplier evidence distinct from the deterministic fixtures. The eventual partner demo must clearly show which boundary is simulated and which is live.
