# Occavoy contributor instructions

These instructions apply to human contributors and coding agents throughout this repository. Use the current task, the nearest applicable instructions, and the checked-in implementation together. Do not assume that a planning document describes a deployed feature.

## Start here

1. Read the root README, [PRD](docs/product/prd-v0.2.md), [architecture](docs/architecture.md), [execution model](docs/agent-execution.md), [handoff](docs/implementation-handoff.md), and the issue being worked on.
2. Check `git status` and identify the branch, worktree, files owned by the task, and any work already in progress.
3. Pick the smallest change that proves the issue's acceptance criteria. Record an architectural change in `docs/adr/` before relying on it.

## Product and architecture boundaries

- The initial customer audience is Hong Kong consumers and their channel partners. Destinations are global from the first version. Japan is one demonstration fixture, never a product-wide restriction.
- Rivet Cloud hosts execution. One deterministic service-case coordinator advances each case; a separate scoped Pi Durable actor owns each bounded reasoning job. These are compatible durability scopes, not competing authorities. Cloudflare Workers Paid with TanStack Start owns the web and request boundary.
- Postgres is the intended authority for commercial records. Actor checkpoints and chat transcripts are not independent authorities for quotes, approvals, orders, or payments.
- Restate is not a default dependency. A separately owned, self-hosted use requires a demonstrated need and an ADR. Never give two engines ownership of the same case lifecycle.
- The production harness candidate is `@rivet-dev/pi` with its exact compatible Pi Durable dependencies. See ADR 0005. Do not invoke a developer CLI per customer request or expose developer tools to customer jobs. Do not upgrade the Pi family independently of adapter compatibility.
- Agent results are candidates bound to tenant, case, job and input revision. Deterministic code and a database transaction decide whether they may change business state. Retry a submission with its original request ID; do not convert a timeout into a new job or purchase.
- The legacy `demoCase` restart fixture is not a service-case implementation. Follow the handoff's supported action/inbox design; do not copy deprecated queue APIs into new production modules.
- Sandbox execution is optional. Evaluate Docker `sbx` first when isolation is needed; keep it disabled until its capabilities are proven. E2B or bounded Lambda tool execution are explicit fallback candidates.
- Enforce the R2 application storage budget of `8_000_000_000` bytes through atomic reservations and reconciliation. This is not a native R2 account quota or a promise that all cloud usage is free.
- A saved event does not authorize open-ended execution. A customer approval binds a specific proposal version, amount, currency, scope, and expiry.
- A supplier quote is not an inventory hold. A successful payment is not a confirmed booking. An unknown external result must be reconciled before retrying an irreversible operation.
- Keep original currencies, local dates, IANA time zones, source provenance, and uncertainty. Never invent inventory, supplier access, partnerships, or verified prices.

## Tools and commands

Use repository-pinned tools through `mise`, `pnpm`, and `uv`; do not install global alternatives or silently update lockfiles.

```sh
mise install
mise run bootstrap
pnpm dev
pnpm dev:runtime
pnpm check
uv run --package occavoy-evals pytest experiments/evals/tests
```

The root manifests define the commands. If a command and these instructions diverge, fix the discrepancy within the assigned scope or report it. Dependency changes require exact versions, updated lockfiles, a reason, and the relevant compatibility check.

MCP servers are optional interfaces. Use approved connectors, CLIs, SDKs, or ordinary repository tools according to availability. Do not make local development depend on a particular coding-agent vendor or a collection of installed MCP servers. See [development guidance](docs/development.md).

Keep this file as the common instruction entry point. Do not regenerate `CLAUDE.md` or `GEMINI.md` bridge files.

## Concurrent work

- Prefer a separate branch or worktree for independent tasks. In a shared worktree, agree file ownership before editing.
- Do not revert, reset, clean, reformat, or stage another contributor's changes incidentally. An explicitly assigned integrator may assemble agreed changes.
- Keep commits focused and commit in meaningful, logically self-contained steps rather than bundling unrelated changes.
- When introducing a substantial feature or fix, open a GitHub pull request and invoke Codex review on the PR (`@codex review`) before merging.
- State dependencies and unresolved questions in the handoff; do not mark cloud deployment, supplier integration, or an external issue complete without evidence.
- Keep public handoffs reproducible: issue reference, paths changed, commands run, observed results, and remaining blockers. Do not copy private conversation history into the repository.

## Verification

- Test the changed behaviour and its material failure boundary. Runtime and transaction changes need recovery, duplicate-delivery, and unknown-result cases as applicable.
- Run affected checks while working and the repository check before integration. For documentation-only changes, formatting and link checks are normally sufficient.
- Distinguish pure tests, local runtime tests, cloud integration proofs, and commercial trials. Passing one does not establish the others.
- Record measured engineering time, blocked time, provider calls, and test coverage against acceptance criteria. Do not claim an acceleration factor without comparative evidence.

## Public repository hygiene

Commit only public-safe source, documentation, and clearly labelled synthetic fixtures. Keep credentials, live customer details, private financial plans, personal biographies, supplier net rates, production receipts, access tokens, and signed URLs out of Git, logs, screenshots, and fixtures. Use ignored local files and the relevant secret store.

Use the authority granted by the task. Do not send external messages, create real bookings, charge customers, or expose private records merely to make a demo pass. If a required external operation is not authorized or a credential is unavailable, finish the reviewable local work and state the specific remaining requirement.
