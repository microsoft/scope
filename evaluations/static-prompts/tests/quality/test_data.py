import logging

from azure.ai.evaluation._common.utils import reformat_agent_response, reformat_conversation_history

from static_prompt_evals.quality.data import normalize_rows, sdk_messages, tool_response_messages


def test_dependency_query_uses_production_task_without_reviewed_answer():
    rows = normalize_rows(
        [{"id": "case", "family": "parent-dependency-suggestion",
          "input": {"prompt": "Uses Python", "candidates": []},
          "expected": {"reference": "SECRET REVIEWED ANSWER"}}],
        [{"caseId": "case", "request": {"messages": [
            {"role": "system", "content": "Suggest only genuine prerequisites; empty is allowed."},
            {"role": "user", "content": "Criterion: Uses Python. Candidates: []"},
        ]}, "output": {"suggestions": []}, "rawResponse": '{"suggestions":[]}'}],
        expected_samples=1,
    )
    assert "genuine prerequisites" in rows[0].query
    assert "SECRET REVIEWED ANSWER" not in rows[0].query
    assert "SECRET REVIEWED ANSWER" in rows[0].ground_truth


def test_sdk_conversation_and_real_tool_history_parse_without_fallback(caplog):
    query = sdk_messages([
        {"role": "system", "content": "Summarize recorded evidence."},
        {"role": "user", "content": "Summarize this run."},
    ])
    response = tool_response_messages([
        {"id": "call-1", "name": "get_run_summary", "arguments": {}, "response": {"status": "finished"}},
    ]) + sdk_messages([{"role": "assistant", "content": "The run finished."}])
    logger = logging.getLogger("sdk-schema-test")
    with caplog.at_level(logging.WARNING):
        text = reformat_conversation_history(query, logger=logger, include_system_messages=True)
        answer = reformat_agent_response(response, logger=logger, include_tool_messages=True)
    assert "Summarize recorded evidence." in text
    assert "get_run_summary" in answer
    assert "finished" in answer
    assert not caplog.records


def test_reviewed_tool_calls_are_not_fabricated_as_generation_history():
    row = normalize_rows(
        [{"id": "case", "family": "judge-instructions",
          "expected": {"toolCalls": [{"id": "fake", "name": "read_file"}]}}],
        [{"caseId": "case", "output": {"results": []}}],
        expected_samples=1,
    )[0]
    assert row.tool_calls == []


def test_feedback_uses_generation_context_not_grading_task():
    row = normalize_rows(
        [{"id": "case", "family": "developer-feedback", "input": {"criteria": [{"prompt": "Uses Azure"}]}}],
        [{"caseId": "case", "request": {"messages": [
            {"role": "system", "content": "Give actionable developer feedback, do not score."},
            {"role": "user", "content": "Root failure: Azure integration missing"},
        ]}, "output": {"feedback": "Add Azure integration."}}],
        expected_samples=1,
    )[0]
    assert "Give actionable developer feedback" in row.query
    assert "Root failure" in row.context


def test_contribution_graders_receive_rendered_report_not_raw_tool_payload():
    row = normalize_rows(
        [{"id": "contribution", "family": "contribution-insights",
          "expected": {"referenceReport": "Skipped CI is not passing evidence."}}],
        [{"caseId": "contribution", "output": {
            "report": {"schemaVersion": 2, "assessments": []},
            "markdown": "# Contribution Insights\n\nReport-only; skipped checks are not passes.",
        }, "rawResponse": "Submitted."}],
        expected_samples=1,
    )[0]
    assert row.response.startswith("# Contribution Insights")
    assert "skipped checks are not passes" in row.response
    assert row.response != "Submitted."


def test_decision_normalization_preserves_native_request_and_raw_response_without_treating_it_as_prose():
    native_request = {
        "state": {"copilotInsights": {"readiness": "needs-clarification", "limitations": ["Missing patch."]}},
        "questions": {"review_action": {"type": "choice"}},
    }
    raw = '{ "model": "microsoft-decision-1", "answers": {"review_action": {"choice": "manual-review-required"}} }'
    row = normalize_rows(
        [{"id": "decision", "family": "contribution-decision",
          "input": {"assessment": native_request["state"]["copilotInsights"]},
          "expected": {"action": "manual-review-required", "note": "SECRET REVIEWED ORACLE"}}],
        [{"caseId": "decision", "request": {
            "decisionRequest": native_request,
            "messages": [{"role": "user", "content": "Partial grader projection only."}],
            "metadata": {"fidelity": "partial"},
        }, "output": {"decision": {
            "action": "manual-review-required", "provider": "Microsoft-Decision-1", "status": "completed",
        }}, "rawResponse": raw}],
        expected_samples=1,
    )[0]

    assert row.response == "manual-review-required"
    assert row.raw_response == raw
    assert row.decision_request == native_request
    assert row.metadata["requestFidelity"] == "partial"
    assert "Missing patch." in row.context
    assert "review_action" in row.query
    assert "SECRET REVIEWED ORACLE" not in row.query + row.context
    assert "SECRET REVIEWED ORACLE" in row.ground_truth
    assert row.response_messages == [{"role": "assistant", "content": [{"type": "text", "text": "manual-review-required"}]}]
    assert not row.tool_calls
