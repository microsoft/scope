from pathlib import Path
from dataclasses import replace
import json
import logging
import pytest

from static_prompt_evals.quality.azure import (
    AzureRuntime,
    evaluate_with_retry,
    evaluator_column_mapping,
    observation_from_sdk_row,
    run_azure_evaluations,
    parse_native_result,
    create_evaluator,
    validate_sdk_input,
)
from static_prompt_evals.quality.models import NormalizedRow
from static_prompt_evals.quality.data import sdk_messages, sdk_tool_call, tool_response_messages


def _row() -> NormalizedRow:
    return NormalizedRow(
        row_id="case::sample-0",
        case_id="case",
        family="criteria-authoring",
        variant="default",
        sample_index=0,
        source_category="fixture",
        query="Create a criterion",
        response="Check the implementation.",
        context="Repository evidence",
        ground_truth="Use both evidence sources",
        expected_behavior="Create an evaluable criterion",
        input={},
        expected={},
        expected_labels={"criteria_evidence_source": "both"},
        output={"prompt": "Check the implementation."},
        raw_response="",
        query_messages=[{"role": "user", "content": "Create a criterion"}],
        response_messages=[
            {"role": "assistant", "content": "Check the implementation."}
        ],
        tool_definitions=[],
        tool_calls=[],
    )


def test_builtin_column_mappings_use_message_fields_for_task_adherence() -> None:
    mapping = evaluator_column_mapping(
        {"name": "task_adherence", "type": "builtin"}
    )

    assert mapping == {
        "query": "${data.query_messages}",
        "response": "${data.response_messages}",
    }


def test_expected_label_overrides_grader_pass_flag() -> None:
    observation = observation_from_sdk_row(
        "criteria_evidence_source",
        {
            "name": "criteria_evidence_source",
            "type": "label",
            "expectedLabelKey": "criteria_evidence_source",
            "passingLabels": ["both"],
        },
        {
            "outputs.criteria_evidence_source.label": "codebase",
            "outputs.criteria_evidence_source.passed": True,
        },
        _row(),
    )

    assert observation.passed is False
    assert observation.details["expectedLabel"] == "both"


def test_retry_only_retries_transient_errors() -> None:
    attempts = 0

    class TransientError(RuntimeError):
        status_code = 429

    def operation():
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise TransientError("rate limited")
        return {"rows": [], "metrics": {}}

    result, used_attempts = evaluate_with_retry(
        operation,
        max_attempts=3,
        base_delay_seconds=0,
        sleep=lambda _: None,
    )

    assert result["rows"] == []
    assert used_attempts == 3


def test_azure_orchestration_preserves_native_row_output(tmp_path: Path) -> None:
    row = _row()
    runtime = AzureRuntime(
        model_config={
            "azure_endpoint": "https://example.invalid",
            "azure_deployment": "grader",
            "api_key": "not-a-real-key",
        },
        credential=None,
        project=None,
        deployment="grader",
        sdk_version="1.18.5",
        auth_mode="api-key",
    )

    def fake_evaluate(**kwargs):
        evaluator = next(iter(kwargs["evaluators"]))
        return {
            "rows": [
                {
                    "inputs.row_id": row.row_id,
                    f"outputs.{evaluator}.score": 4,
                    f"outputs.{evaluator}.passed": True,
                    f"outputs.{evaluator}.reason": "meets the rubric",
                }
            ],
            "metrics": {f"{evaluator}.pass_rate": 1.0},
            "studio_url": None,
        }

    outcomes = run_azure_evaluations(
        [row],
        family_specs={
            "criteria-authoring": [
                {
                    "name": "criteria_quality",
                    "type": "score",
                    "range": [1, 5],
                    "scorePassThreshold": 3,
                    "prompt": "Score criterion quality.",
                }
            ]
        },
        runtime=runtime,
        output_dir=tmp_path / "azure-native",
        evaluate_callable=fake_evaluate,
    )

    assert outcomes[0].status == "succeeded"
    assert outcomes[0].observations[0].passed is True
    assert (tmp_path / "azure-native" / "criteria-authoring" / "criteria_quality.json").is_file()


@pytest.mark.parametrize("label,expected", [("codebase", "codebase"), ("tool_history", "tool-history")])
def test_nested_sdk_label_and_explicit_alias(label, expected):
    observation = observation_from_sdk_row(
        "criteria_evidence_source",
        {"type": "label", "labels": ["codebase", "tool_history"], "expectedLabelKey": "criteria_evidence_source"},
        {"outputs.criteria_evidence_source.passed": True,
         "outputs.criteria_evidence_source.sample": {"output": [
             {"role": "assistant", "content": json.dumps({
                 "result": label, "steps": [{"conclusion": "Evidence is appropriate"}],
             })},
         ]}},
        replace(_row(), expected_labels={"criteria_evidence_source": expected}),
    )
    assert observation.passed is True
    assert observation.reason == "Evidence is appropriate"


@pytest.mark.parametrize("native", [
    {}, {"outputs.criteria_evidence_source.passed": True},
    {"outputs.criteria_evidence_source.label": "invented"},
    {"outputs.criteria_evidence_source.sample": {"output": [{"role": "assistant", "content": "not JSON"}]}},
])
def test_invalid_label_never_becomes_prompt_failure(native):
    observation = observation_from_sdk_row(
        "criteria_evidence_source", {"type": "label", "labels": ["both"], "expectedLabelKey": "criteria_evidence_source"},
        native, _row(),
    )
    assert observation.passed is None
    assert observation.infrastructure_error


@pytest.mark.parametrize("score", [float("nan"), float("inf"), -1, 6, True, "bad", None])
def test_invalid_scores_never_use_pass_flag(score):
    observation = observation_from_sdk_row("quality", {"type": "score", "range": [1, 5]},
                                          {"outputs.quality.score": score, "outputs.quality.passed": True}, _row())
    assert observation.passed is None


def test_native_row_ids_cannot_fall_back_to_position():
    with pytest.raises(ValueError, match="unknown or duplicate"):
        parse_native_result({"rows": [{"row_id": "wrong", "outputs.quality.score": 5}]},
                            {"name": "quality", "type": "score"}, [_row()])


def test_missing_native_row_and_sdk_skip_are_invalid():
    for native in [[], [{"row_id": _row().row_id, "outputs.quality.status": "skipped"}]]:
        observations, _ = parse_native_result({"rows": native}, {"name": "quality", "type": "score"}, [_row()])
        assert len(observations) == 1
        assert observations[0].passed is None


def _runtime():
    return AzureRuntime(
        {"azure_endpoint": "https://example.invalid", "azure_deployment": "grader", "api_key": "not-real"},
        None, None, "grader", "1.18.5", "api-key",
    )


def _tool_row(call):
    return replace(
        _row(), family="run-report",
        query_messages=sdk_messages([{"role": "user", "content": "Summarize the run."}]),
        response_messages=tool_response_messages([call]) + sdk_messages([
            {"role": "assistant", "content": "The run finished."},
        ]),
        tool_calls=[sdk_tool_call(call)],
        tool_definitions=[{"name": "get_run_summary", "description": "Read the run.",
                           "parameters": {"type": "object", "properties": {}}}],
    )


@pytest.mark.parametrize("name", ["task_adherence", "tool_call_accuracy"])
@pytest.mark.parametrize("call", [
    {"id": "call-1", "type": "tool_call", "name": "get_run_summary", "arguments": {}, "response": "finished"},
    {"id": "call-1", "type": "function", "function": {"name": "get_run_summary", "arguments": "{}"}, "response": "finished"},
])
def test_tool_messages_pass_actual_pinned_sdk_validation_and_conversion(name, call):
    row = _tool_row(call)
    expected = {"type": "tool_call", "tool_call_id": "call-1", "name": "get_run_summary", "arguments": {}}
    assert row.response_messages[0]["content"] == [expected]
    assert row.tool_calls == [expected]
    spec = {"name": name, "type": "builtin", "scorePassThreshold": 1 if name == "task_adherence" else 3}
    evaluator = create_evaluator(spec, _runtime())
    validate_sdk_input(evaluator, spec, row)
    if name == "tool_call_accuracy":
        converted = evaluator._convert_kwargs_to_eval_input(
            query=row.query_messages, response=row.response_messages,
            tool_calls=row.tool_calls, tool_definitions=row.tool_definitions,
        )
        assert "error_message" not in converted
        assert converted["tool_calls"][0]["name"] == "get_run_summary"
        assert converted["tool_definitions"]


def test_bad_nested_tool_schema_is_rejected_before_evaluate(tmp_path):
    row = replace(_tool_row({"id": "call-1", "name": "get_run_summary", "arguments": {}}),
                  response_messages=[{"role": "assistant", "content": [{
                      "type": "tool_call",
                      "tool_call": {"id": "call-1", "type": "function",
                                    "function": {"name": "get_run_summary", "arguments": {}}},
                  }]}])
    def forbidden(**kwargs):
        raise AssertionError("SDK input validation must occur before evaluate/model calls")
    outcomes = run_azure_evaluations(
        [row], family_specs={"run-report": [{"name": "task_adherence", "type": "builtin", "scorePassThreshold": 1}]},
        runtime=_runtime(), output_dir=tmp_path / "azure-native", evaluate_callable=forbidden,
    )
    assert outcomes[0].status == "infrastructure-failed"
    assert "'name' field" in outcomes[0].error
    assert outcomes[0].artifact is None
    diagnostic = json.loads((tmp_path / outcomes[0].diagnostic_artifact).read_text())
    assert "'name' field" in diagnostic["error"]


def test_sdk_summary_errors_are_retained_when_native_rows_have_no_outputs(tmp_path, monkeypatch):
    monkeypatch.setattr("static_prompt_evals.quality.azure.create_evaluator", lambda spec, runtime: object())
    rows = [_row(), replace(_row(), row_id="case::sample-1", sample_index=1)]
    logger = logging.getLogger("azure.ai.evaluation._evaluate._evaluate")
    previous_level, previous_handlers = logger.level, list(logger.handlers)
    error = "(UserError) Each tool_call content items must contain a 'name' field."
    def evaluate(**kwargs):
        logger.info("run_summary: \r\n%s", json.dumps({"task_adherence": {
            "status": "Completed", "completed_lines": 1, "failed_lines": 1,
            "error_code": "FAILED_EXECUTION", "error_message": None,
            "per_line_errors": {"1": error},
        }}))
        return {"rows": [
            {"inputs.row_id": rows[1].row_id},
            {"inputs.row_id": rows[0].row_id, "outputs.task_adherence.score": 1},
        ], "metrics": {}}
    outcome = run_azure_evaluations(
        rows, family_specs={"criteria-authoring": [{"name": "task_adherence", "type": "builtin", "scorePassThreshold": 1}]},
        runtime=_runtime(), output_dir=tmp_path / "azure-native", evaluate_callable=evaluate,
    )[0]
    by_id = {o.row_id: o for o in outcome.observations}
    assert by_id[rows[0].row_id].passed is True
    assert by_id[rows[1].row_id].passed is None
    assert "'name' field" in by_id[rows[1].row_id].reason
    assert by_id[rows[1].row_id].details["sdkEvaluatorError"] is True
    diagnostic = json.loads((tmp_path / outcome.diagnostic_artifact).read_text())
    assert diagnostic["rowErrors"] == {rows[1].row_id: "RuntimeError: " + error}
    assert diagnostic["runSummary"]["failed_lines"] == 1
    native = json.loads((tmp_path / outcome.artifact).read_text())
    assert not any(key.startswith("outputs.") for key in native["rows"][0])
    assert logger.level == previous_level and logger.handlers == previous_handlers
