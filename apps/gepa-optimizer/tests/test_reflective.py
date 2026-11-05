# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

from gepa_optimizer.reflective import build_reflective_record


def test_reflective_record_shape_and_content():
    traj = {
        "task": "Build an Express server",
        "runOutcome": "succeeded",
        "score": 0.5,
        "turns": [
            {
                "iteration": 0,
                "response": "first attempt",
                "judgeFeedback": "missing route",
                "criteriaResults": [
                    {"criterionId": "server_starts", "passed": True, "evaluated": True, "feedback": "ok"},
                    {"criterionId": "hello", "passed": False, "evaluated": True, "feedback": "no /"},
                ],
            },
        ],
    }
    rec = build_reflective_record(traj, ["server_starts", "hello"])
    assert set(rec.keys()) == {"Inputs", "Generated Outputs", "Feedback"}
    assert rec["Inputs"] == "Build an Express server"
    assert "first attempt" in rec["Generated Outputs"]
    assert "Turn 0" in rec["Generated Outputs"]
    # Feedback surfaces score, judge narrative and per-criterion pass/fail.
    assert "Overall score: 0.500" in rec["Feedback"]
    assert "missing route" in rec["Feedback"]
    assert "[PASS] server_starts" in rec["Feedback"]
    assert "[FAIL] hello" in rec["Feedback"]


def test_skipped_criterion_flagged():
    traj = {
        "task": "t",
        "runOutcome": "succeeded",
        "score": 0.0,
        "turns": [
            {
                "iteration": 0,
                "response": "x",
                "judgeFeedback": "",
                "criteriaResults": [
                    {"criterionId": "a", "passed": False, "evaluated": True, "feedback": ""},
                    {"criterionId": "b", "passed": True, "evaluated": False, "feedback": ""},
                ],
            }
        ],
    }
    rec = build_reflective_record(traj, ["a", "b"])
    assert "SKIPPED" in rec["Feedback"]


def test_error_trajectory_surfaces_error():
    traj = {"task": "t", "score": 0.0, "turns": [], "error": "timeout"}
    rec = build_reflective_record(traj, ["a"])
    assert "Evaluation error: timeout" in rec["Feedback"]
    assert rec["Generated Outputs"] == "(no turns)"


def test_failed_outcome_noted():
    traj = {"task": "t", "runOutcome": "failed", "score": 0.0, "turns": []}
    rec = build_reflective_record(traj, ["a"])
    assert "Run outcome: failed" in rec["Feedback"]


def test_truncation_keeps_tail():
    long_resp = "A" * 50 + "TAILMARK"
    traj = {
        "task": "t",
        "runOutcome": "succeeded",
        "score": 1.0,
        "turns": [{"iteration": 0, "response": long_resp, "judgeFeedback": "", "criteriaResults": []}],
    }
    rec = build_reflective_record(traj, ["a"], max_chars=20)
    assert rec["Generated Outputs"].startswith("...(truncated)...")
    assert "TAILMARK" in rec["Generated Outputs"]
