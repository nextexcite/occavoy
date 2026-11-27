"""Summarize measured case runs without treating failed work as free."""

import argparse
import json
import math
from decimal import Decimal
from pathlib import Path


def summarize(rows: list[dict]) -> dict:
    """One row per case, including all retry costs; unknown cases stay in the denominator."""
    elapsed = []
    costs = []
    operator_minutes = []
    outcomes = {"completed": 0, "failed": 0, "cancelled": 0, "unknown": 0}
    duplicates = 0
    case_ids = set()
    for row in rows:
        case_id = row["case_id"]
        if not isinstance(case_id, str) or not case_id or case_id in case_ids:
            raise ValueError("Each observation needs a unique nonempty case_id")
        case_ids.add(case_id)
        outcome = row["outcome"]
        if outcome not in outcomes:
            raise ValueError(f"Unknown outcome: {outcome}")
        duration = float(row["elapsed_ms"])
        cost = Decimal(str(row["model_cost_usd"]))
        effort = float(row["operator_minutes"])
        duplicate_count = row["duplicate_effect_count"]
        if not math.isfinite(duration) or duration < 0:
            raise ValueError("elapsed_ms must be finite and nonnegative")
        if not cost.is_finite() or cost < 0:
            raise ValueError("model_cost_usd must be finite and nonnegative")
        if not math.isfinite(effort) or effort < 0:
            raise ValueError("operator_minutes must be finite and nonnegative")
        if type(duplicate_count) is not int or duplicate_count < 0:
            raise ValueError("duplicate_effect_count must be a nonnegative integer")
        elapsed.append(duration)
        costs.append(cost)
        operator_minutes.append(effort)
        outcomes[outcome] += 1
        duplicates += duplicate_count
    elapsed.sort()
    total = sum(costs, start=Decimal(0))
    return {
        "cases": len(rows),
        "outcomes": outcomes,
        "model_cost_usd": str(total),
        "cost_per_case_usd": str(total / len(rows)) if rows else None,
        "cost_per_completed_case_usd": str(total / outcomes["completed"])
        if outcomes["completed"]
        else None,
        "operator_minutes": sum(operator_minutes),
        "elapsed_p95_ms": elapsed[math.ceil(0.95 * len(elapsed)) - 1] if elapsed else None,
        "duplicate_effect_count": duplicates,
        "no_duplicate_effects_observed": duplicates == 0 and bool(rows),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("jsonl", type=Path)
    args = parser.parse_args()
    rows = [json.loads(line) for line in args.jsonl.read_text().splitlines() if line.strip()]
    print(json.dumps(summarize(rows), indent=2))


if __name__ == "__main__":
    main()
