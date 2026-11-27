# Local environment lifecycle

This document is the operating manual for the Occavoy local development environment: how to
build it from scratch on a fresh machine, and how to maintain it afterwards. It complements
[development.md](development.md) (workflow rules) — this file is about the environment itself.

## Topology: what runs where

The environment is **not** fully containerized. Exactly one service runs in Docker; everything
else is a host process through the pinned toolchain.

| Piece                           | How it runs                                                                                                                    | Managed by                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Toolchain (node/pnpm/python/uv) | Host binaries                                                                                                                  | `mise` (pins in `mise.toml`)                                   |
| TypeScript dependencies         | `node_modules/` on host                                                                                                        | `pnpm install --frozen-lockfile`                               |
| Python dependencies             | `.venv/` on host                                                                                                               | `uv sync --all-packages --locked`                              |
| Postgres 17                     | Docker container `occavoy-postgres` on `127.0.0.1:54329`                                                                       | `compose.yaml` (only service)                                  |
| Rivet runtime                   | **In-process** embedded local engine in the dev Node process; file-backed durability, control plane on `http://localhost:6420` | `pnpm dev:runtime` — no container, no server, no cloud account |
| Web frontend                    | Host process (TanStack Start / Vite with local Workers emulation)                                                              | `pnpm dev`                                                     |
| Secrets                         | Doppler is canonical; fnox maps profiles to it; consumption is an ignored local dotenv file                                    | Never committed                                                |

There is no self-hosted Rivet server locally and no Restate instance. Rivet Cloud
credentials are only for the future cloud qualification step; local runtime
work uses `OCCAVOY_RUNTIME_MODE=local` and needs no cloud access.

## Secrets doctrine: target vs. current state

**Target model** — doctrine agreed with the project owner; implementation is pending and
tracked as its own setup task, so nothing below is in the repo yet:

- **Toolchain**: `mise` pins all tools including `fnox`; `fnox` owns project secret references
  and encrypted profiles through a committed, value-free `fnox.toml`; **Doppler** is the
  canonical secret store; **direnv** is optional and, where used, limited to a deterministic,
  side-effect-free `.envrc` — never global shell activation or provider network access on
  directory entry.
- **Doppler configs**: `local` serves the local development cycle. `dev`, `staging`, and
  `production` exist only if the project genuinely operates them — Occavoy currently operates
  `local` only. No invented environment aliases.
- **Identity**: the project has its own project-specific age keypair. The recipient public key
  lives in the committed fnox configuration; the private key is delivered through the machine
  or sandbox environment — never through Git, chat, or patches. It is not a machine, personal,
  or recovery identity. **Open decision (Linear OCA-35):** where the private key is stored for
  owned-machine bootstrap (a dedicated restricted Doppler config vs. platform injection only).
  Implementation of the fnox layer waits on that decision.
- **Portable development**: selected development credentials are published as age ciphertext
  (encrypted to the project recipient) so a fresh cloud sandbox or agent machine only needs
  the private key present in its environment to decrypt everything and start work — no
  interactive secret entry, no copying another machine's dotenv. Doppler remains canonical;
  published ciphertext is derived distribution, not a second editable source, and rotating a
  source credential requires republication plus consumer refresh.
- **Consumption**: dotenv-first. An explicit refresh materializes an ignored local env file
  (atomic, mode-0600 replacement; fail closed on missing inputs); ordinary development reads
  that file. Verification is by presence check only — values never appear in agent output,
  logs, patches, or docs.

### fnox mechanics rules (for the implementation task)

These are the load-bearing upstream behaviors the future `fnox.toml` and refresh wrapper must
respect; they are easy to get subtly wrong:

- Add the official schema URL (`https://fnox.jdx.dev/schema.json`) to `fnox.toml`; use
  `fnox exec`, never `fnox run`; fnox flags go before `--`, child-command arguments after.
- `fnox set` reads values from a hidden prompt or stdin — never command-line arguments
  (visible through process inspection). `default` values are always plaintext, even when other
  entries use encryption. Encryption providers store ciphertext in config; storage providers
  store references — preserve that distinction when editing `value` fields by hand.
- `--no-defaults` excludes top-level secrets but **not** profile inheritance, global config,
  or ambient credentials — it is not isolation. Inspect the real merge with
  `fnox config-files` before trusting a lane boundary.
- `fnox export --dry-run` is **not** a redaction mode — stdout can contain values. Presence
  verification is `fnox check` / `fnox scan` / `fnox env --json --describe`; never `fnox get`,
  `list --values`, or export dry-runs in agent-visible output.
- `export -f env` excludes `env = false` and `env = "exec"` inputs by default; never use
  `--all` to force exec-only inputs into a dotenv file. `env = "exec"` is exposure policy,
  not an authorization boundary.
- The dotenv refresh lane: export to a private staging path outside the loader's input
  (`umask 077`), validate expected names without printing values, then atomically replace the
  ignored env file only on success. A failed refresh preserves the last working file.
- Recipient changes require `fnox reencrypt -p <provider>`; inspect the dry run before writing.
- Platform injection for sandboxes uses `FNOX_AGE_KEY` / `FNOX_AGE_KEY_FILE`; the private key
  never enters app env, Git, or snapshots. Never snapshot decrypted env files, identities, or
  login state.

### Age identity roles

An age recipient is a decryption principal: adding a recipient expands the trust set, and
multiple recipients mean alternative decryption — not multi-party approval. Roles stay
distinct and never share one identity:

1. **Workstation identity** — device-scoped, for a person on that machine.
2. **Recovery identity** — project or project-family scoped, in offline/recovery custody,
   never injected into routine CI or sandboxes.
3. **CI/deployment identity** — dedicated per repository or deployment trust boundary.
4. **Cloud-development identity** — the project-specific keypair this doctrine centers on,
   injected into authorized sandboxes/agent machines only.

No per-secret or per-worktree keys — a worktree inherits the repo's committed config and
materializes its own ignored file. Whoever holds the cloud-dev private key can decrypt every
obtainable ciphertext addressed to it, including historical Git objects; project-scoped
injection limits where the key is _delivered_, not what it can decrypt once obtained. On
compromise, rotate the underlying exposed credentials — rotating recipients only protects
future ciphertext. Consumers fail closed on a missing or wrong key; they never fall back to
online source providers.

**Current state** — what actually exists today:

- **Implemented**: fnox pinned in `mise.toml` (1.50.0); committed value-free `fnox.toml`
  mapping the `local` profile to Doppler `occavoy/local`; the project age keypair generated
  (public recipient in `fnox.toml`, private key on this machine at
  `~/.config/fnox/occavoy-dev.key`, mode 0600, never committed); the refresh lane
  `mise run secrets:refresh` materializing `.env.local` inside a marker-managed block;
  and `fnox -P local --no-defaults exec -- <cmd>` as the injection lane for commands.
- **Still pending**: the portable-development publication lane (age ciphertext in Git) and
  sandbox key injection — they wait on the key-custody decision in Linear OCA-35. The Rivet
  Cloud entries (`RIVET_ENDPOINT`, `RIVET_TOKEN`, `RIVET_ORG`, `RIVET_CLUSTER`) remain
  unmanaged manual entries in `.env.local` until cloud qualification is assigned; the refresh
  lane preserves them.
- The interim `doppler run --project occavoy --config local -- <cmd>` invocation still works
  (same underlying CLI session) but is superseded by the fnox lanes; prefer them so the
  profile boundary in `fnox.toml` is the single mapping.

## Fresh setup from scratch

Prerequisites on the host: Docker with a running daemon, [mise](https://mise.jdx.dev), and the
Doppler CLI authenticated (`doppler login`) with access to the `occavoy` project.

```sh
git clone https://github.com/nextexcite/occavoy.git
cd occavoy

# 1. Pinned toolchain: node 26.13.1, pnpm 12.23.0, python 3.15.2, uv 0.13.10
mise trust
mise install

# 2. Both locked workspaces (pnpm + uv)
mise run bootstrap

# 3. Postgres (the only container)
docker compose up -d
# Wait for healthy: pg_isready -h 127.0.0.1 -p 54329

# 4. Materialize local secrets from the fnox profile (requires doppler login)
mise run secrets:refresh
```

This writes `.env.local` (ignored, mode 0600) inside a marker-managed block; hand-added
entries outside the markers are preserved. After a refresh, plain `pnpm dev:runtime` and
`pnpm test` read the local snapshot offline. CI or shell variables already set in the
process take precedence in this loader. Use `fnox exec` only for explicit live resolution.

Verify the setup end to end:

```sh
mise exec -- pnpm check                                                    # TS lint/typecheck/test/build
mise exec -- pnpm check:python                                             # ruff + eval pytest
mise exec -- pnpm verify:harness                                           # real Rivet/Pi Durable probe, no paid inference
mise exec -- pnpm demo:lifecycle                                           # synthetic business-state scenario
```

A full pass of the first two commands is the definition of "environment is set up". The
Postgres-backed tests self-skip without `DATABASE_URL`; confirm they ran rather than assuming a pass.

## Day-to-day operation

Start/stop what you need; nothing needs to run permanently.

```sh
pnpm dev            # web preview on http://localhost:3000
pnpm dev:runtime    # local Rivet probe on http://localhost:6420
docker compose up -d    # postgres, if not already running
docker compose down     # stop postgres (data persists in the occavoy_pgdata volume)
```

The dev database is disposable. To reset it completely: `docker compose down -v` then
`docker compose up -d`; migrations re-apply automatically on first use
(`applyMigrations` in `packages/storage`). Never do this against any shared or cloud database.

## Maintenance rules

- **Tool versions** live in `mise.toml` only. Changing one is a deliberate commit: update the
  pin, run `mise install`, re-run `mise run check`, and state the reason. Do not install
  global tool alternatives as a workaround.
- **JS dependencies** require an exact version in the relevant `package.json`, an updated
  `pnpm-lock.yaml`, and a reason in the commit. Use `pnpm add`/`pnpm add -w` rather than
  editing manifests by hand. Never silently update the lockfile.
- **Python dependencies** go into the `uv` workspace (`pyproject.toml` + `uv.lock`); run
  `uv sync --all-packages` after changing them. Do not create separate venvs or per-experiment
  environments.
- **The Pi harness family** (`@rivet-dev/pi` + `@earendil-works/*`) is a tested combination
  pinned by ADR 0005. Never upgrade one member independently of the adapter's peer range.
- **compose.yaml** stays minimal. Do not add services (a self-hosted engine, a queue, a cache)
  without an ADR; the Rivet runtime is intentionally in-process locally.
- **Secrets**: additions go to the canonical Doppler config (`occavoy/local` for local
  development), then add the variable _name_ to the matching profile in `fnox.toml` and to
  `.env.example` with an empty value. Nothing secret enters Git, docs, fixtures, or logs;
  `fnox.toml` stays value-free. Re-run `mise run secrets:refresh` after any change.
- **Lockfiles are the baseline.** If `mise run bootstrap` fails after a pull, the correct fix
  is usually `pnpm install --frozen-lockfile` / `uv sync --all-packages --locked` again — not
  regenerating the lockfile to match a local drift.

## Troubleshooting

| Symptom                                        | Likely cause and fix                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `pnpm`/`node` version mismatch errors          | Shell not using mise shims — run commands as `mise exec -- <cmd>` or `mise run <task>`                       |
| Postgres tests skip silently                   | `DATABASE_URL` unset — run through `fnox -P local --no-defaults exec --` or check `mise run secrets:refresh` |
| `pg_isready` fails on 54329                    | Container stopped: `docker compose up -d`; port collides only if host Postgres was manually bound to 54329   |
| `docker: permission denied` on the socket      | User not in the `docker` group — use sudo or fix group membership; do not weaken socket permissions          |
| Harness verification complains about the token | `OCCAVOY_RUNTIME_DEMO_TOKEN` must be present in the _same_ shell that runs the verification                  |
| Rivet Cloud commands fail locally              | Expected in local mode — unmanaged `.env.local` Rivet entries are only for the cloud qualification step      |
| Engine state confusion after crash tests       | Local engine data is file-backed and disposable; it must never be committed — check `.gitignore` if unsure   |

## Ownership note

`docs/development.md` owns workflow rules (branching, verification, handoffs). This file owns
machine state. When the two drift apart — e.g. a new required service or secret — update both
in the same commit and mention the change in the handoff.
