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
