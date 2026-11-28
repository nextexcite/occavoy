# Local environment and secrets

This project keeps secrets out of Git entirely. `fnox.toml` is the committed, value-free
mapping: which named variables the `local` profile selects from the project's secret store.
No plaintext values, key material, or machine-specific configuration live in the repository.

## Refresh lane

```sh
mise run secrets:refresh
```

This resolves the `local` profile and rewrites the fnox-managed block inside the ignored
`.env.local` at the repository root. The refresh:

- validates that resolution returns exactly the declared names — missing, unexpected, or
  empty values fail by name, never printing a value;
- requires `OCCAVOY_RUNTIME_MODE` to resolve to `local` and `OCCAVOY_RUNTIME_DEMO_TOKEN`
  to be at least 32 characters when present;
- encodes values so they round-trip byte-for-byte through Node `util.parseEnv`, verifying
  the merged file before replacing anything;
- preserves unmanaged entries and comments outside the managed block;
- replaces the file atomically with mode 0600 only on success — any failure leaves the
  previous file and its permissions untouched.

Run the refresh explicitly: after a rotation, on first setup, or when a profile changes.
Nothing resolves secrets or touches the network on directory entry.

## Use the snapshot

Local runtime and test processes read the snapshot at startup, without fetching secrets.
Restart the process after a refresh. `scripts/load-local-env.mjs` is the narrow preload contract:

- it materializes only the exact local names — `DATABASE_URL`, `OCCAVOY_RUNTIME_MODE`,
  `OCCAVOY_RUNTIME_DEMO_TOKEN` — the same set the fnox local profile declares;
- inherited environment always wins over the file;
- a missing file is tolerated; any other read failure fails closed;
- a snapshot whose mode is not `local` is rejected, even when overridden;
- unknown keys in the file are never spread into the process environment.

When approving another local name, update the fnox mapping and loader together; the profile
contract test rejects differences in either direction.

The runtime `dev` and `test` scripts preload it automatically, as does the vitest setup.
Workers and browser code never auto-load it.

`DATABASE_URL` remains application runtime configuration. Ordinary database-backed tests ignore it, including when it arrives through this snapshot. Those tests run only when `OCCAVOY_TEST_DATABASE_URL` is explicitly set to the disposable Compose target; the selector rejects other targets and query-option overrides before connecting. The explicit test selector is not part of the fnox local profile.

The [runtime metrics listener](../apps/runtime/README.md#rivet-cloud-hosted-node) is cloud-only. Its optional `RIVETKIT_METRICS_PORT` setting is not part of the local profile and is ignored in local mode.

## One-off commands: `pnpm local:exec`

```sh
pnpm local:exec pg_isready -h 127.0.0.1 -p 54329
```

`local:exec` overlays the snapshot onto the inherited environment and then replaces its
process image with the command (`execve`). There is no wrapper left in between, so a
supervisor can signal the service — including SIGTERM — directly by PID. Because `pnpm`
itself is a wrapper, supervisors that need an exact PID should invoke
`node scripts/local-exec.mjs <command> [args...]` directly. On platforms without POSIX
`execve`, pass explicit per-command environment instead. Arguments pass through verbatim;
the command name itself must never be `NAME=value` or a lone dash, because those are
`env` syntax that would print the environment rather than run a program. There is no
plaintext cache or daemon beyond the ignored snapshot file.

## Live resolution

`local` is a target profile, not a network prohibition. The snapshot is a convenient
default, not a mandate: whenever freshness or online work calls for it — an environment
switch, a deliberate rotation, or one-off verification — use scoped live resolution rather than waiting for a refresh:

```sh
fnox -P local --no-defaults exec -- <command>
doppler run --project occavoy --config <explicit-config> -- <command>
```

Neither the snapshot nor live resolution may widen scope: the routine `local` profile
never carries cloud or bootstrap credentials, nothing fetches on directory entry, and
there is no copying snapshots between machines or reverse-syncing values back into the
store. The portable ciphertext-publication lane and its key custody are deferred to
Linear OCA-35.

The shared inference settings (OPENAI_API_KEY, OPENAI_BASE_URL and OPENAI_WIRE_API) live in the Doppler root config and are inherited by local and dev only. They are not part of the routine local snapshot; rotate the parent rather than adding child overrides.

## Hygiene

- Never pass secret values as CLI arguments, print them, or paste them into issues, logs,
  or screenshots. Verify presence, not content.
- The Compose Postgres fixture at `postgresql://127.0.0.1:54329/occavoy` with the public
  local-only `occavoy`/`occavoy` credentials is a safe example application `DATABASE_URL`
  target — a disposable loopback database, never a shared or production one. Database-backed
  tests require the separate exact `OCCAVOY_TEST_DATABASE_URL` opt-in.
- Do not copy another checkout's `.env.local` snapshot; refresh per checkout.
- Missing access fails closed and is reported by variable name; do not select another
  project's source or broaden the profile to make a check pass.
