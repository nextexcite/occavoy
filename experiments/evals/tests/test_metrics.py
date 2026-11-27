import pytest
from occavoy_evals.metrics import summarize


def observation(case_id="case-1", outcome="completed", cost="0.10", **overrides):
    return {
        "case_id": case_id,
        "outcome": outcome,
        "elapsed_ms": 100,
        "model_cost_usd": cost,
        "operator_minutes": 1,
        "duplicate_effect_count": 0,
        **overrides,
    }


def test_failed_and_unknown_work_still_costs_money():
    result = summarize(
        [
            observation(),
            observation("case-2", "failed", "0.20"),
            observation("case-3", "unknown", "0.30"),
        ]
    )
    assert result["model_cost_usd"] == "0.60"
    assert result["cost_per_completed_case_usd"] == "0.60"
    assert result["cost_per_case_usd"] == "0.20"


def test_empty_dataset_cannot_prove_success():
    result = summarize([])
    assert result["cost_per_completed_case_usd"] is None
    assert not result["no_duplicate_effects_observed"]


def test_duplicate_ids_cannot_double_count_the_same_case():
    with pytest.raises(ValueError, match="unique"):
        summarize([observation(), observation()])


@pytest.mark.parametrize("cost", ["NaN", "Infinity", "-1"])
def test_invalid_costs_are_rejected(cost):
    with pytest.raises(ValueError):
        summarize([observation(cost=cost)])


def test_duplicate_external_effect_is_visible():
    result = summarize([observation(duplicate_effect_count=1)])
    assert not result["no_duplicate_effects_observed"]
    assert result["duplicate_effect_count"] == 1
