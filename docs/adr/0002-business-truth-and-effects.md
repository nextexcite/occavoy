# ADR 0002: Business records and recoverable external actions

Status: accepted design; implementation must pass failure tests.

## Decision

Keep commercial truth in Postgres. Rivet execution state stores command reception, progress, and references to business records. Proposal terms, approvals, orders, and payments must not have independently authoritative copies in actor memory or a transcript.

Accept commands transactionally with an outbox. Deliver at least once, deduplicate by command ID and payload hash, and persist completion separately from reception. An identical retry returns the earlier result; the same ID with different input is rejected.

Use a conditional business version and unique action IDs even when one case maps to one actor. Runtime serialization is not a replacement for database constraints or supplier-side idempotency.

## External effects

Before a purchase or other state-changing provider action, persist its fixed ID, client reference, input hash, authorized proposal, and validity. Record dispatch intent before making the external call. An interrupted action is potentially sent until a query or human reconciliation establishes otherwise.

| Observation                                    | Allowed response                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------- |
| Provider confirms the original action          | Store the receipt under the original ID                           |
| Provider confirms no action occurred           | Decide whether a permitted retry is still valid                   |
| Provider cannot establish the result           | Preserve `unknown` and assign reconciliation                      |
| Customer cancels after dispatch may have begun | Stop new actions; reconcile and apply the provider's change rules |

Re-check approval, price validity, and cancellation at the point of dispatch. A new proposal requires a new approval. Expiry or local rollback does not undo a provider's action.

## Recovery

After a process restart, reuse a committed command result instead of repeating the commercial effect. Reconcile pending outbox entries, stalled commands, and unknown actions. If restoring older data, treat actions after the recovery point as uncertain until checked. A new runtime instance must not allow a stale instance to continue issuing writes unchecked.

## Required tests

- Crash after command acceptance but before delivery.
- Crash after business commit but before execution checkpoint.
- Duplicate and out-of-order supplier replies.
- Concurrent approval and cancellation.
- Supplier success followed by a lost local response.
- Quote expiry before dispatch.
- Partial order success and a late cancellation response.

These tests establish project invariants. No claim of provider-wide exactly-once execution follows from local deduplication.
