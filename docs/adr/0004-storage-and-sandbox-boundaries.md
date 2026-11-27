# ADR 0004: Bounded object storage and optional sandbox tools

Status: accepted storage policy; sandbox provider is a qualification candidate.

## R2 storage policy

The initial application budget is **8 GB = 8,000,000,000 bytes**, shared by all Occavoy-managed objects in the configured storage budget. It is an application rule. R2's documented per-bucket storage capacity is not an 8 GB quota. Storage volume also does not bound request charges or other provider costs. [R2 limits](https://developers.cloudflare.com/r2/platform/limits/) · [R2 pricing](https://developers.cloudflare.com/r2/pricing/)

All production writers use a shared upload policy:

1. Establish a bounded byte length before accepting an object write. Reject unknown or excessive input unless a bounded streaming path has been proven.
2. Atomically reserve those bytes against committed storage plus outstanding reservations. Refuse admission if the cap would be exceeded.
3. Write under an operation-specific object key; record actual size and evidence references.
4. Settle the reservation once. Keep ambiguous writes reserved until object existence and size are reconciled.
5. Release storage only after deletion is confirmed. Count retained copies and multipart data conservatively until cleaned up.

A browser or another service must not bypass reservation with an unrestricted upload credential. Start with controlled application uploads. Reconcile the storage ledger with R2 observations and alert before capacity is exhausted. Out-of-band writes require the same policy or are treated as drift that closes new admission.

Concurrent uploads at the cap, duplicate completion, uncertain write outcomes, and failed deletion are required tests. A pure arithmetic helper alone is not evidence of atomic enforcement in a deployed system.

### Local Postgres inspection and recovery

`PostgresQuotaLedger.getBudgetReport()` compares budget counters with reservation rows in one database snapshot. `activeReservations` counts `reserved` rows; `unknownReservations` counts ambiguous writes, whose bytes remain reserved. A zero `discrepancyBytes` means the database counters agree, not that R2 inventory has been verified.

`reconcileExpiredReservations(now)` returns newly expired rows for inspection; it never refunds capacity. To recover outstanding work after a reconciler restart, read `object_reservation WHERE state = 'unknown'`, including `object_key`, `bytes`, `actual_bytes` and `reconciliation_note`. Verify the final object size before calling `commit(id, observedBytes)`. If the object is absent, rule out any pending write before calling `releaseVerifiedAbsent(id, evidenceNote)`. A known oversized object blocks new admissions until resolved. There is no automatic deletion or inventory scan here; keep uploads disabled pending R2 integration.

## Sandbox policy

Use deterministic code and bounded API adapters by default. Enable isolated code or browser execution only for a demonstrated tool requirement. Rivet remains the case owner and records the tool's request, allowance, deadline, and result.

**Docker `sbx` is the first provider to evaluate.** Docker currently labels Agentic Platform experimental, and cloud sandbox access has separate prerequisites and lifecycle behavior. Verify the pinned CLI, isolation, network policy, secret delivery, persistence, timeout action, export, and cleanup before enabling it. [Platform status](https://docs.docker.com/agentic-platform) · [Cloud sandbox documentation](https://docs.docker.com/ai/sandboxes/cloud/)

If it does not meet a measured requirement, evaluate E2B for a sandbox workload or Lambda for a bounded function. These are fallback candidates, not automatic dependencies. Lambda is not a replacement case workflow or an unrestricted long-running sandbox.

Every provider adapter must declare support for network restrictions, maximum duration, cancellation, output limits, secret scope, result retrieval, and cleanup. A provider without a required capability is unavailable for that tool. Do not silently fall back to executing untrusted work on the application host.

Sandbox readiness does not block a proof consisting only of trusted deterministic logic, approved model requests, and a controlled supplier stub.
