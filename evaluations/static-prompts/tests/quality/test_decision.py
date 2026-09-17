from dataclasses import replace
from pathlib import Path

import pytest

from static_prompt_evals.quality.aggregate import aggregate_quality
from static_prompt_evals.quality.decision import build_decision
from static_prompt_evals.quality.models import EvaluatorRunOutcome, MetricObservation
from static_prompt_evals.quality.configuration import load_quality_configuration
from static_prompt_evals.quality.data import normalize_rows
from static_prompt_evals.quality.deterministic import evaluate_sample_diversity
from static_prompt_evals.quality.runner import gate_coverage


def observations(passing, total=25):
    return [
        MetricObservation(f"case-{i}::sample-0", f"case-{i}", "family", "default", "fixture", 0,
                          "quality", i < passing, score=4 if i < passing else 2)
        for i in range(total)
    ]


@pytest.mark.parametrize("passing,floor,expected", [
    (20, 0.8, "passed"), (19, 0.8, "failed"),
    (17, 0.67, "passed"), (24, 1.0, "failed"), (25, 1.0, "passed"),
])
def test_exact_configured_floors(passing, floor, expected):
    summary, _, _ = aggregate_quality(
        observations(passing), family_thresholds={"family": {"quality": {"minPassRate": floor}}},
    )
    decision = summary["decision"]
    assert decision["acceptance"] == expected
    assert decision["gates"][0]["passRate"] == passing / 25
    assert decision["gates"][0]["requirements"]["effectiveMinPassRate"] == floor


def test_baseline_derived_requirement_is_not_capped():
    summary, _, _ = aggregate_quality(
        observations(20), family_thresholds={"family": {"quality": {
            "minPassRate": 0.67, "baselinePassRate": 1, "maxRegression": 0.05,
        }}},
    )
    gate = summary["decision"]["gates"][0]
    assert gate["requirements"]["baselineDerivedMinPassRate"] == 0.95
    assert gate["requirements"]["effectiveMinPassRate"] == 0.95
    assert gate["passRate"] == 0.8
    assert gate["status"] == "failed"
    assert "passRateCap" not in gate["requirements"]
    assert "uncappedMinPassRate" not in gate["requirements"]


def test_mean_score_independently_blocks_passing_rate():
    summary, _, _ = aggregate_quality(
        [replace(o, score=2) for o in observations(25)],
        family_thresholds={"family": {"quality": {"minPassRate": 0.8, "minMeanScore": 3}}},
    )
    assert summary["decision"]["acceptance"] == "failed"
    assert "mean score" in summary["decision"]["gates"][0]["violations"][0]


def test_missing_evaluator_is_unresolved_not_passed():
    summary, _, status = aggregate_quality(
        [], family_thresholds={"family": {"quality": {"minPassRate": 0.8}}},
        azure_outcomes=[EvaluatorRunOutcome("family", "quality", "infrastructure-failed", None)],
    )
    assert status == "infrastructure-failed"
    assert summary["decision"]["acceptance"] == "undetermined"
    assert summary["decision"]["totals"]["blockingUnresolved"] == 1


def test_partial_failure_requires_best_completion_bound():
    for passing, expected in [(19, "unresolved"), (18, "failed")]:
        source = observations(passing, 24)
        summary, _, _ = aggregate_quality(
            source, family_thresholds={"family": {"quality": {"minPassRate": 0.8}}},
            coverage={("family", "quality"): {"applicable": 25}},
        )
        assert summary["decision"]["gates"][0]["status"] == expected
        assert summary["decision"]["integrity"] == "incomplete"


def test_advisory_only_and_early_failure():
    summary, _, status = aggregate_quality(
        observations(0), family_thresholds={"family": {"quality": {"minPassRate": 0.8, "blocking": False}}},
    )
    assert status == "succeeded"
    assert summary["decision"]["acceptance"] == "not-evaluated"
    assert summary["decision"]["totals"]["advisoryViolations"] == 1
    assert build_decision([], {}, execution="incomplete")["acceptance"] == "undetermined"


def test_legitimate_skips_are_separate_from_missing():
    decision = build_decision([], {"family": {"optional": {"minPassRate": 0.67}}},
                              coverage={("family", "optional"): {
                                  "applicable": 0, "skipped": 25, "notApplicable": True,
                              }})
    assert decision["gates"][0]["status"] == "not-applicable"
    assert decision["acceptance"] == "not-evaluated"
    assert decision["totals"]["skippedCases"] == 25


def test_invalid_sample_is_not_a_failed_prompt():
    source = observations(1, 1)
    summary, findings, _ = aggregate_quality(
        [replace(source[0], passed=None, infrastructure_error=True)],
        family_thresholds={"family": {"quality": {"minPassRate": 0.8}}},
    )
    assert summary["decision"]["totals"]["caseFailureRecords"] == 0
    assert not any(f["kind"] == "case-failure" for f in findings)


def tool_rows():
    return normalize_rows(
        [{"id": "tool-case", "family": "judge-instructions", "input": {"request": "Assess the evidence."}}],
        [{
            "caseId": "tool-case", "sampleIndex": sample,
            "request": {
                "messages": [{"role": "user", "content": "Assess the evidence."}],
                "tools": [{"name": "read_file"}],
            },
            "output": {"results": []},
            "invocationMetadata": {"toolCalls": [
                {"id": "call-0", "name": "read_file", "arguments": {}, "response": "evidence"},
            ]} if sample == 0 else {},
        } for sample in range(3)],
        expected_samples=3,
    )


@pytest.mark.parametrize("passed", [False, True])
def test_one_tool_grade_and_two_missing_traces_leave_case_unknown(passed):
    rows = tool_rows()
    rubric = load_quality_configuration(Path(__file__).resolve().parents[2] / "evaluators/rubrics.yaml")
    first = rows[0]
    observation = MetricObservation(
        first.row_id, first.case_id, first.family, first.variant, first.source_category,
        first.sample_index, "tool_call_accuracy", passed, score=4 if passed else 1,
    )
    summary, findings, _ = aggregate_quality(
        [observation], family_thresholds={first.family: {"tool_call_accuracy": {"minPassRate": 0.8}}},
        coverage=gate_coverage(rows, rubric),
    )
    case = summary["caseResults"][0]
    assert case["casePassed"] is None
    assert case["meanScore"] is None
    assert case["expectedSampleCount"] == 3
    assert case["missingSampleCount"] == 2
    gate = summary["decision"]["gates"][0]
    assert gate["status"] == "unresolved"
    assert gate["invalid"] == 1 and gate["evaluated"] == 0
    assert gate["passRate"] is None and gate["meanScore"] is None
    assert gate["coverageComplete"] is False
    assert not any(f["kind"] in {"case-failure", "threshold"} for f in findings)


def test_historical_case_verdict_is_unknown_when_expected_samples_are_absent():
    decision = build_decision(
        [{"family": "family", "evaluator": "quality", "caseId": "case",
          "casePassed": False, "meanScore": 1, "samples": [{"rowId": "case::sample-0"}]}],
        {"family": {"quality": {"minPassRate": 0.8}}},
        coverage={("family", "quality"): {
            "applicable": 1,
            "expectedRowIdsByCase": {"case": [f"case::sample-{i}" for i in range(3)]},
        }},
    )
    assert decision["gates"][0]["status"] == "unresolved"
    assert decision["totals"]["caseFailureRecords"] == 0


def test_case_level_diversity_result_does_not_require_one_grade_per_sample():
    rows = [replace(row, family="task-prompt-variation") for row in tool_rows()]
    rubric = load_quality_configuration(Path(__file__).resolve().parents[2] / "evaluators/rubrics.yaml")
    observations = evaluate_sample_diversity(rows, {"metric": "sample_diversity"})
    summary, _, _ = aggregate_quality(
        observations, family_thresholds={"task-prompt-variation": {"sample_diversity": {"minPassRate": 0.67}}},
        coverage=gate_coverage(rows, rubric),
    )
    assert summary["caseResults"][0]["expectedSampleCount"] == 1
    assert summary["caseResults"][0]["missingSampleCount"] == 0
    assert summary["decision"]["gates"][0]["invalid"] == 0
    assert summary["decision"]["gates"][0]["coverageComplete"] is True
