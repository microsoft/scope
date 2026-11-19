from static_prompt_evals.quality.aggregate import aggregate_quality, strict_majority
from static_prompt_evals.quality.models import MetricObservation


def _observation(sample: int, passed: bool | None, *, infra: bool = False):
    return MetricObservation(
        row_id=f"case::sample-{sample}",
        case_id="case",
        family="family",
        variant="default",
        source_category="fixture",
        sample_index=sample,
        evaluator="quality",
        passed=passed,
        score=4.0 if passed else 2.0,
        infrastructure_error=infra,
    )


def test_strict_majority_rejects_ties() -> None:
    assert strict_majority([True, True, False]) is True
    assert strict_majority([True, False]) is False


def test_threshold_failure_uses_case_majority() -> None:
    summary, findings, status = aggregate_quality(
        [_observation(0, True), _observation(1, False), _observation(2, False)],
        family_thresholds={
            "family": {"quality": {"minPassRate": 1.0, "minMeanScore": 3.0}}
        },
        model="grader",
    )

    assert status == "failed"
    assert summary["aggregates"]["byFamily"][0]["passRate"] == 0
    assert {finding["kind"] for finding in findings} == {
        "case-failure",
        "threshold",
    }


def test_nonblocking_threshold_does_not_fail_run() -> None:
    _, findings, status = aggregate_quality(
        [_observation(0, False)],
        family_thresholds={
            "family": {
                "quality": {"minPassRate": 1.0, "blocking": False}
            }
        },
    )

    assert status == "succeeded"
    assert any(finding.get("severity") == "warning" for finding in findings)


def test_incomplete_sample_is_infrastructure_failure() -> None:
    _, findings, status = aggregate_quality(
        [_observation(0, True), _observation(1, None, infra=True)],
        family_thresholds={"family": {"quality": {"minPassRate": 1.0}}},
    )

    assert status == "infrastructure-failed"
    assert findings[0]["kind"] == "infrastructure"
