# ADR 0001: Edge web application and Rivet Cloud execution

Status: accepted direction; cloud compatibility proof required.

## Decision

- Use TypeScript, TanStack Start, and the Cloudflare Vite integration for `apps/web` on **Workers Paid**.
- Run the case lifecycle in a Node application on **Rivet Cloud Actor Nodes**.
- Use `mise` for exact tool versions, `pnpm` for the TypeScript workspace, and `uv` for separate Python experiments and evaluations.
- Keep Postgres-backed business persistence and R2 object storage behind application contracts.
- Do not deploy a self-hosted Rivet control plane for the initial product. Local execution is for development and recovery tests.

Cloudflare documents a TanStack Start integration with Workers and server-side bindings. Rivet Cloud runs an application container as an Actor Node. These provide distinct execution boundaries; a request handler does not own a long-lived case. [Cloudflare guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/) · [Rivet cloud guide](https://rivet.dev/docs/deploy/cloud/compute/)

## Version qualification

The initial Rivet stable candidate is `3.1.1`. Exact SDK, CLI, Node, build tooling, and transitive lockfiles belong in the repository manifests. Select stable direct dependencies and exact pins rather than `latest`, an RC, or a floating range. An update is a separate compatibility change with recorded results. The release tag and rolling documentation may expose different workflow APIs. [Rivet 3.1.1](https://github.com/rivet-dev/rivet/releases/tag/v3.1.1)

Stable direct packages do not guarantee a prerelease-free dependency tree. For example, the selected stable Cloudflare Vite plugin declares prerelease internal dependencies. Retain the supported locked resolution, record relevant compatibility risk, and do not override internals merely to remove a suffix. [Versioned plugin manifest](https://github.com/cloudflare/workers-sdk/blob/%40cloudflare/vite-plugin%401.70.2/packages/vite-plugin-cloudflare/package.json)

The pinned Rivet workflow queue used by the initial proof is deprecated in that release. Treat it as a contained qualification path. Before assisted commercial use, confirm a supported workflow interface or record a tested migration; do not silently combine it with a rolling standalone workflow package.

The deployed-node configuration must connect to the cloud control plane rather than starting another embedded engine. Follow the pinned version and [current cloud deployment instructions](https://rivet.dev/docs/deploy/cloud/compute/); keep cluster-injected credentials out of source and browser bundles.

## Restate boundary

Restate is a possible **self-hosted secondary component only**. It is not installed or selected by default. Introducing it requires:

1. A reproducible requirement that the selected Rivet path does not meet.
2. A separately named operation owner and state boundary; no shared ownership of a case.
3. A comparison of integration, recovery, deployment, and maintenance work.
4. A new ADR and tests covering the handoff between engines.

An available SDK, benchmark, or preference for another abstraction is insufficient by itself.

## Acceptance

- Web build runs with the selected Workers configuration.
- The exact Rivet image and dependencies deploy to the intended cloud cluster.
- A persisted test case waits, the process is replaced, and the case continues once.
- The web app can resume a persisted case timeline without holding an original request open.
- The same release records local and cloud test evidence separately.

## Consequence

The first deployment has two application runtimes and one case owner. This adds a network boundary but avoids forcing durable case execution into the web request lifecycle. Production readiness remains a measured outcome, not a benefit inferred from choosing managed services.
