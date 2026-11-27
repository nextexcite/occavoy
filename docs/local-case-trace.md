# OCA-34: one local case, one supplier submission

At code commit `4063434`, a loopback HTTP client activated a London fixture, a scoped approver accepted its one-component hotel proposal, and a synthetic supplier accepted the order but lost its reply. Postgres kept the case waiting for reconciliation. A lookup under the original reference confirmed the booking: **one submission, one synthetic order**. No customer, payment processor, model provider, or live supplier participated.

## Reproduce

Use the [local development setup](development.md) and the repository's disposable Compose Postgres, never a shared or production database. From the repository root:

```sh
docker compose up --detach --wait postgres
mise exec -- pnpm --filter @occavoy/runtime build
DATABASE_URL=postgresql://127.0.0.1:54329/occavoy PGUSER=occavoy PGPASSWORD=occavoy \
  mise exec -- node --import tsx --test apps/runtime/test/local-case-trace.test.mjs
```

The test starts an ephemeral loopback HTTP listener and creates its own Postgres schema. Both are removed on completion. Look for **one passed test and zero skipped**: without `DATABASE_URL` the test skips. The public [web form](../apps/web/src/routes/case.tsx) remains a preview; the [intake handler](../apps/web/src/server/case-intake.ts) is only mounted by the test.

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
