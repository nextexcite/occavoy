# Experiments

Each experiment is a package in the shared `uv` workspace. Keep hypotheses, reproducible inputs,
observed results and a decision together. Production TypeScript code remains in `apps/` and
`packages/`; promote useful findings deliberately rather than importing notebooks into runtime.

```sh
mise run bootstrap
uv run --package occavoy-evals pytest experiments/evals/tests
uv run --package occavoy-evals occavoy-eval path/to/actual-runs.jsonl
mise run experiment -- supplier-quotes
uv sync --all-packages
```

`evals` starts with a measurement utility. Each JSONL observation has `case_id`, `outcome`
(`completed`, `failed`, `cancelled`, `unknown`), `elapsed_ms`, `model_cost_usd`,
`operator_minutes`, and `duplicate_effect_count`. Each row represents one distinct case and
includes the cost of all attempts and retries for that case. Failed and unknown cases remain
in the totals. Raw elapsed duration includes waiting; add active-runtime and recovery timings in
the workload experiment before using the result to size infrastructure.

New experiments should answer one question: recovery correctness, model/tool cost, supplier
latency, global time/currency handling, or isolated compute. Keep actual client data and raw
provider responses in ignored `data/private/` and `results/`, never Git history. Redacted evidence
can be checked into `docs/evidence/` once reviewed. Synthetic observations are fixtures and do not
prove the runtime works.
