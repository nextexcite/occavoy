# Shared development workflow

This repository supports human developers and different coding agents. The root [AGENTS.md](../AGENTS.md) is the common instruction entry point. Repository tools, contracts, and evidence remain the same whichever assistant is used.

## Start a task

Read the relevant requirement, ADR, and acceptance criteria. Check the current diff and claim a bounded write scope. Prefer one branch or worktree per independent task. Shared-worktree contributors must agree who owns each file, especially root manifests, lockfiles, migrations, and generated routing files.

Use the pinned toolchain:

```sh
mise install
mise run bootstrap
pnpm dev
pnpm dev:runtime
```

The bootstrap task installs the TypeScript workspace and synchronizes the Python workspace. The root manifests are authoritative; do not create agent-specific copies of these commands.

## Implement one observable slice

1. Name the customer or operator action and the required business invariant.
2. Define or update its shared contract before adding a provider-specific implementation.
3. Build the shortest working path through the affected modules.
4. Exercise its material failure boundary, not just a successful response.
5. Record what actually ran and the next unresolved dependency.

Keep domain logic independent from cloud bindings. Use small adapters for storage, runtime delivery, model calls, and supply. Python experiments may explore an approach, but production behavior must enter the shared contracts and tests before it becomes a product dependency.

## Checks

```sh
docker compose up --detach --wait postgres
DATABASE_URL=postgresql://127.0.0.1:54329/occavoy PGUSER=occavoy PGPASSWORD=occavoy mise exec -- pnpm check
mise exec -- pnpm check:python
mise exec -- pnpm verify:runtime
mise exec -- pnpm verify:harness
uv run --package occavoy-evals pytest experiments/evals/tests
```

The Compose Postgres service is a local disposable fixture. The `occavoy`/`occavoy` credentials are public local-only fixture values — never point these commands at a production or shared database. Plain `pnpm check` without `DATABASE_URL` skips the database-backed suites. The product checkout has no env-file loader; pass the variables in the shell as above.

`pnpm check` is the TypeScript workspace integration check. `pnpm check:python` adds Python lint, formatting, and the evaluation tests; the final command above runs just the evaluation tests. Run the relevant package checks during development and the root check before integration. Run Python checks when experiments or their contracts change. Formatting and relative-link checks are sufficient for ordinary documentation-only edits.

Create a new Python experiment with `mise run experiment -- <slug>`. Keep it in the `uv` workspace rather than creating an unrelated environment or dependency lock.

A local fixture test does not prove a cloud account is configured. A health response does not prove recovery. A database schema does not prove that production commands use its transaction boundaries. Report these distinctions in issues and handoffs.

## Cross-agent handoff

Use this compact record in the issue or pull request. Keep real customer data and credentials out of the text.

```text
Scope: issue and acceptance criteria
Changed: relevant paths and contracts
Verified: exact command or scenario, environment, commit/build, observed result
Effort: estimate, active engineering/review time, blocked elapsed time
Dependencies: what another contributor must provide
Remaining: known failure, unverified cloud step, or deliberate deferral
```

Do not stage another contributor's unreviewed files. An integrator can assemble agreed contributions, run combined checks, and link the resulting revision to the work items. Preserve unrelated edits when resolving conflicts.

## MCP and external tools

MCP is an optional access method. No particular MCP server is required to build or test the local repository.

| Capability                  | Suitable access                                              | Rule                                                                          |
| --------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Repository work             | Local Git and filesystem; authorized GitHub connector or CLI | Keep branch and write scope explicit                                          |
| Planning                    | Authorized issue-tracker connector, CLI, or UI               | Record actual state; do not invent issue IDs or mark unverified work complete |
| Technical references        | Pinned source, official docs, approved docs tools            | Check versions before copying examples                                        |
| Cloud inspection/deployment | Authorized provider CLI, SDK, connector, or MCP              | Verify account/project/cluster and the scope already authorized by the task   |
| Browser inspection          | Available browser automation or manual review                | Use test data and preserve public/private boundaries                          |

Keep user-specific MCP configuration and credentials outside Git. If a capability is unavailable, continue with local contracts and fixtures and identify the precise blocked integration step. Do not add a dependency or register a service merely because a tool is installed.

### Optional endpoints

Start with the connections needed for the assigned work: GitHub for repository collaboration, Linear for issues, and Cloudflare documentation for framework questions. These are endpoint examples, not a requirement to enable every server. Client configuration keys and OAuth support differ; follow the linked provider instructions for the chosen client rather than copying a universal configuration file.

| Connection                                                                                                                                                    | Remote HTTP endpoint                  | Authentication and scope                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [GitHub](https://docs.github.com/en/copilot/how-tos/copilot-in-your-ide/customize-copilot/extend-copilot-with-tools-and-context/set-up-the-github-mcp-server) | `https://api.githubcopilot.com/mcp/`  | Use client-supported OAuth. Host or organization policy can affect availability; if a token is necessary, keep it in the client's secret store and limit its scope to the task.          |
| [Linear](https://linear.app/docs/mcp)                                                                                                                         | `https://mcp.linear.app/mcp`          | OAuth is the interactive setup path. Use `/mcp/readonly` for a reader; the main endpoint can expose writes within the authorized account scope.                                          |
| [Cloudflare documentation](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/)                                | `https://docs.mcp.cloudflare.com/mcp` | Select the documentation server when only reference material is needed; it is separate from account operations.                                                                          |
| [Rivet Cloud](https://rivet.dev/docs/deploy/cloud/compute/)                                                                                                   | `https://mcp.rivet.dev/mcp`           | Optional runtime-specific tooling. Follow Rivet's current authentication instructions and scope access to the intended organization and cluster; keep credentials out of the repository. |

Cloudflare account work can optionally use `https://mcp.cloudflare.com/mcp`, with the provider's OAuth flow and only the permissions needed for the authorized operation. It is not part of the default documentation connection. Ordinary Git, provider CLIs, existing connectors, and browser-based account setup remain alternatives.

## Project workflow inventory

Start with these three portable recipes. They are documented workflows, not a requirement to install personal skills or any agent-specific extension. If repetition justifies a local `SKILL.md`, keep it a thin pointer to the same rules and commit it with its tests.

| Recipe           | Trigger                                                                   | Required output                                                                                        |
| ---------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Case change      | Change brief, quote, proposal, approval, order, or relationship behavior  | Updated contract, smallest slice, affected invariant test, evidence record                             |
| Runtime proof    | Change Rivet version, deployment, waiting, delivery, or recovery behavior | Exact versions and environment, injected failure, resulting state, cost/effort observation             |
| Supplier adapter | Add or change a supply source or response path                            | Capability declaration, data/authority boundary, quote validation, duplicate/late/unknown-result cases |

Do not create a separate skill for every command or copy the PRD into each skill. Tool-specific launchers may differ; repository behavior and verification must not.

### Vendor reference inventory

Consult these references for the affected component. They complement the three project workflows; they do not replace business invariants or require installing vendor skills. Treat rolling documentation as guidance and compare examples with the exact versions in the repository before applying them.

| Area               | Primary reference                                                                                                                             | Version and use                                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Cloudflare Workers | [TanStack Start on Workers](https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/)                              | Bindings, Workers compatibility, and the Vite deployment boundary; pins live in `apps/web/package.json` and `wrangler.jsonc`.        |
| TanStack Start     | [React framework documentation](https://tanstack.com/start/latest/docs/framework/react/overview)                                              | Routes, server functions, and server/client boundaries; compare Start and Router versions with `apps/web/package.json`.              |
| Rivet runtime      | [Selected stable source](https://github.com/rivet-dev/rivet/tree/v3.1.1) and [Cloud deployment](https://rivet.dev/docs/deploy/cloud/compute/) | Start from the selected `3.1.1` source and installed SDK declarations. See ADR 0001 before adopting a newer workflow API.            |
| uv experiments     | [Workspace documentation](https://docs.astral.sh/uv/concepts/projects/workspaces/)                                                            | One workspace lock and explicit member execution; tool version lives in `mise.toml`, dependencies in `pyproject.toml` and `uv.lock`. |

## Public documentation and fixtures

Use synthetic identities and explicit fixture metadata. Sourced public event facts need provenance and a review timestamp. Do not commit scraped payloads indiscriminately, real travel documents, private partner terms, receipts, account identifiers, personal compensation, or chat transcripts.

Vendor instructions can change. Link primary sources beside technical claims and pin the implementation separately. Record a substantive change with an ADR; correct ordinary documentation in place without creating needless governance work.
