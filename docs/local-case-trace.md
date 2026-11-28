# OCA-34: one local case, one supplier submission

For the presenter-led **event-access** journey, see [Return to a saved London request](london-saved-case.md). It continues from the recovered Pi job's RFQ, not the hotel quote in the historical trace below.

At code commit `4063434`, a loopback HTTP client activated a London fixture, a scoped approver accepted its one-component hotel proposal, and a synthetic supplier accepted the order but lost its reply. Postgres kept the case waiting for reconciliation. A lookup under the original reference confirmed the booking: **one submission, one synthetic order**. No customer, payment processor, model provider, or live supplier participated.

## Reproduce

Use the [local development setup](development.md) and the repository's disposable Compose Postgres, never a shared or production database. From the repository root:

```sh
docker compose up --detach --wait postgres
mise exec -- pnpm --filter @occavoy/runtime build
OCCAVOY_TEST_DATABASE_URL=postgresql://127.0.0.1:54329/occavoy \
  mise exec -- node --import tsx --test apps/runtime/test/local-case-trace.test.mjs
```

The test starts an ephemeral loopback HTTP listener and creates its own Postgres schema. Both are removed on completion. Look for **one passed test and zero skipped**: without `OCCAVOY_TEST_DATABASE_URL` the test skips. The public [web form](../apps/web/src/routes/case.tsx) remains a preview; the [intake handler](../apps/web/src/server/case-intake.ts) is only mounted by the test.

## What happened

1. **Intake:** `POST /api/cases` returned `202` at case revision 1, brief version 1, with one pending task and zero usage rows. An identical retry returned the original receipt; a changed budget under that command ID returned `409`. Missing credentials, implicit activation, caller-supplied tenant, malformed JSON and oversized bodies did not create a case. A different tenant could use the same client IDs without reusing the first tenant's case.
2. **Requirements and quote:** the case coordinator drained the task after the HTTP response. A scripted runner used one model-call reservation, without calling a model provider. Its accepted requirement led to one synthetic request for quote. A new coordinator instance recovered the `supplier_quote` wait without starting another job. The fixture supplied the hotel quote, including the seller, fulfiller and payee.
3. **Approval:** an operator could not approve on the payer's behalf. The payer approved the exact proposal version, terms hash, line scope, expiry and GBP amount. The quote was not an inventory hold.
4. **Unknown outcome:** the supplier did not support idempotent submission. On the dropped reply, the action remained `unknown` with its action ID, client reference and request hash. Retry was rejected. A simulated payment observation left booking `pending`. A replacement dispatcher looked up the original action and confirmed booking while fulfilment remained `pending`.
5. **Closure and follow-up:** a separate fulfilment observation allowed closure. A second HTTP activation under the same relationship started a new case with no approval, action or usage inherited from the closed case.

## Evidence and limits

- **Implemented and exercised locally:** [HTTP and coordinator trace](../apps/runtime/test/local-case-trace.test.mjs), [atomic create and activate](../packages/storage/src/postgres-case-store.ts), Postgres case/command/outbox and usage records, validated candidate, versioned approval and effect reconciliation. The separate [storage tests](../packages/storage/test/postgres-case-store.test.ts) cover simultaneous identical activations and rollback of rejected intake.
- **Synthetic or scripted:** all identities and grants, catalog, runner, RFQ delivery, operator and payer actions, supplier, payment and fulfilment observations. Only intake traversed HTTP. Component replacement reused Postgres and the same in-memory supplier, not a restarted supplier process. The test invokes the dispatcher explicitly; outbox replay does not authorize a submission.
- **Not yet shown on this path:** a Pi Durable job running on the case's actual actor key, process interruption of this integrated path, changed terms or revoked grants at dispatch, integrated stale replies/cancellation, supplier-scoped HTTP replies, customer/operator UI, or the same HTTP journey for Singapore and Tokyo. Store-level destination tests and the separate Pi restart harness are not substitutes.
- **Cost and time:** the measured test case took 1.348 s (2.838 s for the Node invocation). Zero paid model calls and zero real supplier orders. Human operator actions were scripted; no human service minutes or commercial cost per case were measured. From feature-branch creation to the tested code commit was 22 min 23 s of elapsed engineering time, not measured active human labor. No cloud costs were measured.

This is local integration evidence for [OCA-34](https://linear.app/tianjis/issue/OCA-34), not acceptance of the full issue, a cloud deployment, or the partner demonstration.

## Local Pi recovery: HTTP activation to RFQ

This follow-up starts from `60a8c28`. It tests a different failure from the lost supplier reply above: **the process dies after a scoped read starts, before Pi can checkpoint its result**. It stops at a request for quote, before any quote, approval or order exists.

From the repository root on Linux with `pgrep`, use the pinned tools and the repository's disposable Postgres:

```sh
mise install
mise run bootstrap
# Only if the disposable Compose Postgres is not already running on 54329:
docker compose up --detach --wait postgres
mise exec -- pnpm verify:case-recovery
```

The command builds the runtime, starts a private native Rivet engine and a loopback HTTP listener, and creates a unique schema on `127.0.0.1:54329/occavoy`. It does not read a project `.env`, accept a remote `DATABASE_URL`, stop Postgres, or require a provider key. The [test](../apps/runtime/test/verify-case-recovery.mjs) fails rather than skipping if the fixture database is unavailable. The [fixture host](../apps/runtime/test/fixture-case-host.mjs) and [Pi job](../apps/runtime/test/fixture-case-job.mjs) are not registered by the default server.

| Checkpoint                     | Observed                                                                                                                                                                                                                                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP receipt                   | `202`, case revision 1 / brief version 1, one pending task, zero usage. Only the test host admits 2 model and 2 tool attempts; the intake defaults remain 1 and 0.                                                                                                                                    |
| Before SIGKILL                 | One leased outbox intent, one active Pi input, one admitted faux model call and one admitted read. The read has obtained the event, city and budget from this case and cannot return on the first host.                                                                                               |
| After replacement              | Same private engine state and PG schema. The lease expires; the same intent is claimed a second time. The same actor key, request ID, submission ID and original deadline are observed on both submissions. Pi repeats the safe read, not the model decision that requested it.                       |
| Business commit                | `PiJobAdapter` validates the structured answer from that submission and submits it at expected revision 1. One applied candidate event at revision 2. A separate, deterministic `request_quote` command references the accepted requirement; one RFQ intent and one synthetic delivery at revision 3. |
| Duplicate delivery and waiting | Replaying HTTP activation, Pi submission and the RFQ command changes neither usage nor revision. Postgres waits for `supplier_quote`; no active Pi input, quote, approval or external action remains.                                                                                                 |

**Measured locally, 2026-11-27:** Node 26.13.1, RivetKit 3.1.1, `@rivet-dev/pi` 0.5.7 and Pi Durable 1.5.2. One test passed, zero skipped; 37.082 s for the test, 40.760 s for the Node invocation (excludes build). The four PG reservations were model, tool, tool, model, all for the original task and relationship. Two model turns were faux, both reads were local, and there were zero paid calls, real messages or orders. Roughly 19 minutes elapsed from worktree inspection to the first passing proof, including setup, debugging and verification; active human labor and blocked time were not separately instrumented. This is not a throughput or cost-per-booking measurement.

The separate London supplier test remains the evidence for UNKNOWN, lookup and closure. It passed in 1.546 s with one synthetic order and one supplier submit. The PG-backed `pnpm check` passed with `VITEST_MAX_WORKERS=1` (79 Vitest and 22 Node tests); an earlier parallel run lost two Vitest workers to SIGKILL. `pnpm check:python` passed all 7 tests. The separate `pnpm verify:harness` passed its safe/unsafe tool recovery checks.

This Pi test does not run a supplier reconciliation, inject a concurrent cancellation or brief revision, prove grant revocation at dispatch, exercise other destinations end to end, or qualify cloud recovery, deployment upgrades, production auth, paid inference or partner operations. The default service host still has no production Pi invoker or RFQ sender.
