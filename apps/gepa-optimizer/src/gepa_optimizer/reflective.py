# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""Build GEPA reflective-dataset records from a Scope run trajectory.

Kept as a pure function (no GEPA / network imports) so it is trivially testable.
A reflective record is ``{Inputs, "Generated Outputs", Feedback}`` per the GEPA
``make_reflective_dataset`` contract. The *Feedback* string is the actionable
gradient handed to the reflection LM, so it captures the full multi-turn
trajectory: every turn's score, judge narrative, and per-criterion pass/fail
with the judge's feedback text — emphasizing failed and skipped criteria.
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence

from .scoring import compute_turn_scores


def _format_criteria(results: Sequence[Mapping[str, Any]]) -> str:
    lines: list[str] = []
    for r in results:
        cid = r.get("criterionId", "<unknown>")
        evaluated = bool(r.get("evaluated", True))
        passed = bool(r.get("passed")) and evaluated
        if not evaluated:
            status = "SKIPPED (ancestor failed)"
        elif passed:
            status = "PASS"
        else:
            status = "FAIL"
        feedback = (r.get("feedback") or "").strip()
        suffix = f" — {feedback}" if feedback else ""
        lines.append(f"  - [{status}] {cid}{suffix}")
    return "\n".join(lines)


def build_reflective_record(
    trajectory: Mapping[str, Any],
    requested_criteria: Sequence[str],
    *,
    max_chars: int | None = None,
) -> dict[str, Any]:
    """Turn one Scope trajectory into a single GEPA reflective record."""
    task = trajectory.get("task", "")
    turns = trajectory.get("turns") or []
    overall_score = trajectory.get("score", 0.0)
    error = trajectory.get("error")

    turn_scores = compute_turn_scores({"turns": turns}, requested_criteria)

    output_parts: list[str] = []
    feedback_parts: list[str] = [f"Overall score: {overall_score:.3f}"]
    if trajectory.get("runOutcome") and trajectory["runOutcome"] != "succeeded":
        feedback_parts.append(f"Run outcome: {trajectory['runOutcome']} (scored 0).")
    if error:
        feedback_parts.append(f"Evaluation error: {error}")

    for i, turn in enumerate(turns):
        iteration = turn.get("iteration", i)
        response = (turn.get("response") or turn.get("codingAgentResponse") or "").strip()
        output_parts.append(f"--- Turn {iteration} ---\n{response or '(no response)'}")

        t_score = turn_scores[i] if i < len(turn_scores) else 0.0
        seg = [f"Turn {iteration} score: {t_score:.3f}"]
        judge = (turn.get("judgeFeedback") or "").strip()
        if judge:
            seg.append(f"Judge: {judge}")
        results = turn.get("criteriaResults") or []
        if results:
            seg.append("Criteria:\n" + _format_criteria(results))
        feedback_parts.append("\n".join(seg))

    generated_outputs = "\n\n".join(output_parts) if output_parts else "(no turns)"
    feedback = "\n\n".join(feedback_parts)

    if max_chars is not None and len(generated_outputs) > max_chars:
        # Prioritize the newest turns by keeping the tail.
        generated_outputs = "...(truncated)...\n" + generated_outputs[-max_chars:]

    return {
        "Inputs": task,
        "Generated Outputs": generated_outputs,
        "Feedback": feedback,
    }
