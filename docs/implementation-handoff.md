# Engineering handoff: one durable customer case

Read [AGENTS.md](../AGENTS.md), [agent execution](agent-execution.md), [ADR 0005](adr/0005-agent-harness.md), the current code and the assigned Linear issue before editing. This is a concrete implementation sequence, not a claim that all listed modules exist.

## Starting evidence

| Area           | Current artifact                                                             | What it does not establish                                                            |
| -------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Web            | `apps/web`: discovery, brief and partner previews                            | Authenticated commands, case persistence or live supply                               |
| Runtime        | `apps/runtime`: local Rivet qualification probes                             | Rivet Cloud deployment or a production case coordinator                               |
| Harness        | `@rivet-dev/pi` with a pinned compatible Pi Durable family; `verify:harness` | Paid-model quality, production budgets, commercial authority or Cloud recovery        |
| Lifecycle      | `packages/domain/src/case-lifecycle.ts` and its tests                        | Postgres transactions, a multi-component order system or external provider guarantees |
| Object storage | `packages/storage`: quota admission policy and ledger contract               | A deployed durable quota ledger; uploads remain disabled                              |

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

| Order | Linear work                          | Concrete implementation                                                                                                                                       | Required proof                                                                                          |
| ----- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1     | OCA-33 qualification and OCA-2 Cloud | Preserve the tested compatible dependency tuple; run `verify:harness`; deploy the actual image to Rivet Cloud                                                 | Model/tool loop, duplicate request, interrupted work and tenant boundary checked on the intended build  |
| 2     | OCA-4                                | Add Postgres migrations/repository under `packages/storage`; command + outbox + result transaction; version CAS; effect intent and immutable approval records | Failure after commit/before delivery, duplicate ID, conflicting payload and stale revision              |
| 3     | OCA-5 and OCA-7                      | Implement `apps/runtime/src/service-case.ts` and a case-to-job adapter; atomically claim pending work; schedule due cases; enforce job/case allowance         | Waiting without model work; cancellation while a job runs; restart and missed-completion reconciliation |
| 4     | OCA-6                                | Add a deterministic effect adapter and a fake provider with a persistent action ledger                                                                        | Provider success/local-response-loss; stable reference; no blind reissue; late callback handling        |
| 5     | OCA-9 through OCA-14, narrow subset  | Connect sourced/fixture event → brief → requirements → manual RFQ → quote → proposal                                                                          | The scenario above passes with one supplier component before expanding product coverage                 |
| 6     | OCA-15 through OCA-17                | Connect the three customer areas and operator exception path to the same persisted contracts                                                                  | Refresh/reconnect preserves state; the UI shows waiting, stale approval and unknown outcomes accurately |

The week-2 milestone covers the **narrow integrated scenario**, including a minimal subset of the later business work. Full catalog, partner access controls, polished customer interaction and broader supply remain week-4/pilot work. Do not wait until week 4 to discover that the runtime cannot complete a case.

[OCA-33](https://linear.app/tianjis/issue/OCA-33) tracks the local harness qualification. [OCA-34](https://linear.app/tianjis/issue/OCA-34) is the integrated case acceptance gate across the implementation issues above. The gate does not mark those implementations complete or duplicate their work estimates.

## Required application contracts

These are application-level API targets, not claims that these routes already exist. Keep transport code thin and enforce the same rules in the domain/repository boundary.

| Entry point                             | Input and trusted context                                                   | Durable result                                                               |
| --------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `POST /api/cases`                       | Authenticated principal; explicit activation; brief and client command ID   | Case, command receipt and outbox in one transaction                          |
| `POST /api/cases/:id/commands`          | Principal and tenant from auth; command ID; expected version; typed payload | Accepted or rejected receipt; an identical retry returns the earlier receipt |
| `GET /api/cases/:id`                    | Authorized case access                                                      | Current version, phase, waiting reason and public decision state             |
| `GET /api/cases/:id/timeline?after=...` | Authorized case access and cursor                                           | Persisted ordered events; streaming may deliver additional notifications     |
| `POST /api/supplier-responses`          | Authenticated/signed partner identity; RFQ/version; stable response ID      | Validated observation, deduplication and a case wake command                 |

Approval is a typed command through the same boundary, not a free-text chat acknowledgement. Derive the approving actor and permitted scope from verified identity/grants. An approval must bind the immutable proposal version/hash, exact authorized amount and currency, action scope, and expiry.

An agent-job specification includes:

```ts
// Application contract sketch. Use the checked-in domain types where they exist.
type AgentJobSpec = {
  tenantId: string;
  caseId: string;
  jobId: string;
  requestId: string;
  baseRevision: number;
  briefVersion: number;
  purpose: "clarify_brief" | "derive_requirements" | "explain_proposal";
  toolProfile: "case_readonly_v1";
  deadlineAt: string;
  allowanceId: string;
};
```

The caller, not the model, allocates these fields. A transport retry reuses them. A changed brief or a new reasoning objective gets a new job. Use durable completion lookup under the original job when a reply is lost.

The two current proofs deliberately have separate contracts. The integration must map and validate them explicitly:

| Domain contract | Current runtime probe                | Integration requirement                                                                   |
| --------------- | ------------------------------------ | ----------------------------------------------------------------------------------------- |
| `taskId`        | Actor key's third component, `jobId` | Allocate one stable job identity and persist the mapping.                                 |
| `caseRevision`  | `baseRevision`                       | Reject a result derived from an older case revision.                                      |
| `briefVersion`  | Not present in the probe envelope    | Carry it in the production job input and result; validate it before applying a candidate. |

Do not cast a probe result to `AgentTaskCandidate`. The probe's signed fixture input is not the production authentication, authorization or business-result validation boundary.

## Persistence responsibilities

Before introducing a new state store, explain which existing owner cannot hold the record:

- Postgres: relationships/grants, cases, brief revisions, commands/results, outbox, jobs and allowances, RFQs, quote/proposal revisions, approvals, effects, order/payment/fulfilment observations and timeline events.
- Case actor SQLite: recoverable local receipt/drain state and execution references. It cannot overwrite a newer Postgres business revision.
- Pi actor SQLite: conversation, model/tool checkpoints and submission deduplication for the scoped agent job. Do not put this in an ordinary container-local file.
- R2: bounded evidence objects through the quota ledger. Never use object existence alone as proof of a commercial outcome.

Required database constraints include unique tenant/command ID, unique tenant/action ID and provider reference, payload-hash conflict checks, immutable proposal versions, and conditional case-version updates. The transport may be retried; the transaction must decide whether work is new, already applied, stale, or unresolved.

## Version and framework rules

The selected Rivet adapter currently requires the Pi 1.5 family. Do not replace those pins with upstream Pi 1.6 simply because it is newer. Qualify an adapter upgrade as a tuple, including forward schema migration and an interrupted in-flight job.

The earlier `demoCase` uses the deprecated Rivet queue/workflow APIs. It is retained as a labelled legacy restart proof, not a template for the service coordinator. Use supported actions plus a durable inbox/drain and scheduling for the coordinator, or qualify the separately versioned `@rivet-dev/workflows` package in an ADR if its primitives actually simplify the case. Never silently copy rolling workflow examples into the deprecated API.

Do not install Eve, fx, Restate, a sandbox, another queue, or another state-machine framework just to fill a diagram. The selected job adapter can be replaced when a measured requirement justifies it. A second durability scope is allowed; two authorities for the same business record are not.

## Definition of the next useful result

A reviewable next result is one accepted case that can pause for input, survive a restart, receive a supplier response, enforce current approval and preserve an uncertain supplier outcome. Report the commit, exact commands, environment, observed state transitions, failed scenarios, active engineering time and remaining blockers.

Keep cloud, paid-model and real-supplier evidence distinct from the deterministic fixtures. The eventual partner demo must clearly show which boundary is simulated and which is live.
