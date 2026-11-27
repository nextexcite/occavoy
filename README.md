# Occavoy

Occavoy turns reasons to travel into a continuing service: discover an occasion, clarify the
customer's brief, obtain partner quotes, approve a specific offer, and follow the work through
booking and fulfilment. Customer relationships and channel partners continue across trips.

**Initial audience: Hong Kong consumers. Destinations: global from day one.**

This repository is the engineering home for the first product. The first milestone is a
partner-facing demonstration within four weeks; a usable assisted-service pilot follows within
eight weeks, with a bounded commercial experiment before twelve weeks. Work and acceptance
criteria live in [Linear OCA](https://linear.app/tianjis/project/occavoy-poc-to-commercial-pilot-f8786e997b5e).

## Start developing

Install [mise](https://mise.jdx.dev/getting-started.html), then:

```sh
git clone https://github.com/nextexcite/occavoy.git
cd occavoy
mise trust
mise install
mise run bootstrap
mise run dev
```

The web preview runs at `http://localhost:3000`. In another terminal:

```sh
export OCCAVOY_RUNTIME_MODE=local
export OCCAVOY_RUNTIME_DEMO_TOKEN="$(openssl rand -hex 32)"
mise run runtime
```

The runtime contains the Postgres-backed case coordinator and two isolated qualification actors.
The web screens preview local data; they do not submit a case. The runtime start command and verification
procedure are documented in [apps/runtime/README.md](apps/runtime/README.md). Local development
requires no production credentials.

The [engineering handoff](docs/implementation-handoff.md) is the single current implementation
matrix: what exists, what is proven locally, and what remains unwired.
The [execution diagrams](docs/agent-execution.md) distinguish a customer relationship, a service
case, a bounded agent job, and an external action. Run the domain scenario and real harness
qualification separately:

```sh
mise exec -- pnpm demo:lifecycle
mise exec -- pnpm verify:harness
```

The first is a synthetic business-state scenario. The second exercises the actual Rivet/Pi Durable
integration with a scripted model provider and no paid inference. Neither command establishes a
deployed commercial service.

To see what durability changes for a customer, run `mise exec -- pnpm demo:london` with the
disposable Compose Postgres on port 54329. The [saved-case walkthrough](docs/london-saved-case.md)
lets you reopen the original request, approve one synthetic event-access offer and watch a lost
supplier reply get resolved without rebooking. `pnpm verify:london` runs it unattended.
The [earlier HTTP-to-supplier and RFQ-only traces](docs/local-case-trace.md) remain separate checks.

```sh
mise run check
mise run experiment -- supplier-quotes
```

The first command runs TypeScript checks, tests, the Workers frontend build, and Python checks.
The second creates another package in the `uv` experiment workspace; run `uv sync --all-packages`
after adding its dependencies. See [experiments](experiments/README.md).

## Workspace

| Path                | Responsibility                                                         |
| ------------------- | ---------------------------------------------------------------------- |
| `apps/web`          | TanStack Start frontend and Cloudflare Workers request boundary        |
| `apps/runtime`      | Service-case coordinator, bounded job adapter and qualification actors |
| `packages/domain`   | Global destination, money, event, brief and approval contracts         |
| `packages/storage`  | Postgres case/command/outbox store, usage and quota ledgers            |
| `experiments/*`     | Isolated Python scenarios in one locked `uv` workspace                 |
| `docs/product`      | Current PRD and scope                                                  |
| `docs/adr`          | Architecture decisions and their consequences                          |
| `.github/workflows` | Reproducible CI without cloud deployment or model spending             |

## Technical baseline

- **Web:** Cloudflare Workers Paid, TanStack Start, React and TypeScript.
- **Execution:** Rivet Cloud, Rivet 3 series. A deterministic case coordinator and separate
  scoped agent jobs have distinct responsibilities within the same runtime.
- **Agent harness:** qualify `@rivet-dev/pi@0.5.7` with the compatible Pi Durable `1.5.2`
  family. See the [harness decision](docs/adr/0005-agent-harness.md) before changing these pins.
- **Business records:** Postgres records commands, decisions, immutable commercial versions and
  emitted outbox intents. Explicit case activation is atomic in the local HTTP trace. The public
  intake route and live identity/grant resolution are not wired.
- **Objects:** R2 with an application budget of **8,000,000,000 bytes**, shared across Occavoy's
  managed environments. The Postgres quota ledger exists; live inventory reconciliation and
  uploads remain disabled. An R2 binding is not a native 8 GB account quota.
- **Additional execution:** Restate self-hosted is reserved for a separately justified workflow.
  Sandbox providers remain optional; see the [sandbox decision](docs/adr/0004-storage-and-sandbox-boundaries.md).
- **Toolchain:** `mise.toml`, exact package versions, `pnpm-lock.yaml` and `uv.lock` are the
  reproducible baseline. Versions were checked against official releases/registries on 27 November 2026.

The initial UI uses synthetic experiences in Tokyo, London and Singapore. It makes no live
inventory, pricing, supplier or booking claims. The global scope is reflected in the data
contracts; supply coverage grows through actual partner access.

## Working with a coding agent

Read [AGENTS.md](AGENTS.md) and the assigned OCA issue before editing. This is the common
instruction entry point for human developers and any coding agent.

The [development guide](docs/development.md) covers MCP connections, project workflows,
concurrent work, verification and handoffs. Use the same `mise` tasks in local editors,
remote workspaces and CI. MCP is optional; credentials stay in each user's secret store.

## Documentation and delivery

- [PRD v0.2](docs/product/prd-v0.2.md)
- [Architecture](docs/architecture.md)
- [Customer lifecycle and harness invocation](docs/agent-execution.md)
- [Concrete engineering handoff](docs/implementation-handoff.md)
- [12-week milestones and measured workload](docs/roadmap.md)
- [Development and agent workspace](docs/development.md)
- [Historical project context in Eventsquare](https://chatgpt.com/space/page_6b05bcf5713081919f83e4123d0d20b0)

Current requirements and architectural decisions belong in this repository. Linear is the
execution record for ownership, dependencies, acceptance and actual results. Space retains the
business discussion and earlier proposals. The earlier six-month plan is historical, and a
Japan fixture must not be treated as a destination restriction.

Before cloud deployment, configure the existing Cloudflare account and the Rivet Cloud
organization/cluster, then follow their documented deployment steps. Bootstrap does not create
cloud resources, publish the app, send partner messages or make bookings.
