# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

from gepa_optimizer.scoring import compute_run_score, compute_turn_scores


def _turn(iteration, results):
    return {"iteration": iteration, "criteriaResults": results}


def _r(cid, passed, evaluated=True):
    return {"criterionId": cid, "passed": passed, "evaluated": evaluated, "feedback": ""}


def test_non_done_status_scores_zero():
    run = {"status": "processing", "outcome": "succeeded", "turns": [_turn(0, [_r("a", True)])]}
    assert compute_run_score(run, ["a"]) == 0.0


def test_failed_outcome_scores_zero():
    run = {"status": "done", "outcome": "failed", "turns": [_turn(0, [_r("a", True)])]}
    assert compute_run_score(run, ["a"]) == 0.0


def test_finished_outcome_scores_partial_credit():
    # A run that ran to completion but did not pass every criterion has
    # outcome "finished" — it must still earn its criteria fraction, not 0.0,
    # otherwise GEPA loses its gradient.
    run = {
        "status": "done",
        "outcome": "finished",
        "turns": [_turn(0, [_r("a", True), _r("b", True), _r("c", True), _r("d", False)])],
    }
    assert compute_run_score(run, ["a", "b", "c", "d"]) == 0.75


def test_no_turns_scores_zero():
    run = {"status": "done", "outcome": "succeeded", "turns": []}
    assert compute_run_score(run, ["a"]) == 0.0


def test_none_run_scores_zero():
    assert compute_run_score(None, ["a"]) == 0.0


def test_all_passed_single_turn():
    run = {"status": "done", "outcome": "succeeded", "turns": [_turn(0, [_r("a", True), _r("b", True)])]}
    assert compute_run_score(run, ["a", "b"]) == 1.0


def test_half_passed():
    run = {"status": "done", "outcome": "succeeded", "turns": [_turn(0, [_r("a", True), _r("b", False)])]}
    assert compute_run_score(run, ["a", "b"]) == 0.5


def test_skipped_counts_as_failed():
    # b was skipped (evaluated False) because ancestor a failed.
    run = {"status": "done", "outcome": "succeeded", "turns": [_turn(0, [_r("a", False), _r("b", True, evaluated=False)])]}
    assert compute_run_score(run, ["a", "b"]) == 0.0


def test_denominator_is_requested_criteria_not_returned():
    # Scope omitted 'b' from results entirely; it must still count in the denominator as failed.
    run = {"status": "done", "outcome": "succeeded", "turns": [_turn(0, [_r("a", True)])]}
    assert compute_run_score(run, ["a", "b"]) == 0.5


def test_mean_across_turns():
    run = {
        "status": "done",
        "outcome": "succeeded",
        "turns": [
            _turn(0, [_r("a", False), _r("b", False)]),  # 0.0
            _turn(1, [_r("a", True), _r("b", True)]),    # 1.0
        ],
    }
    assert compute_run_score(run, ["a", "b"], "mean") == 0.5


def test_final_strategy_uses_last_turn():
    run = {
        "status": "done",
        "outcome": "succeeded",
        "turns": [
            _turn(0, [_r("a", False), _r("b", False)]),  # 0.0
            _turn(1, [_r("a", True), _r("b", True)]),    # 1.0
        ],
    }
    assert compute_run_score(run, ["a", "b"], "final") == 1.0


def test_weighted_strategy():
    run = {
        "status": "done",
        "outcome": "succeeded",
        "turns": [
            _turn(0, [_r("a", False), _r("b", False)]),  # 0.0
            _turn(1, [_r("a", True), _r("b", True)]),    # 1.0
        ],
    }
    # 0.8*final(1.0) + 0.2*mean(0.5) = 0.9
    assert compute_run_score(run, ["a", "b"], "weighted") == 0.9


def test_empty_requested_falls_back_to_returned():
    run = {"status": "done", "outcome": "succeeded", "turns": [_turn(0, [_r("a", True), _r("b", False)])]}
    assert compute_run_score(run, []) == 0.5


def test_compute_turn_scores_order():
    run = {"turns": [_turn(0, [_r("a", True)]), _turn(1, [_r("a", False)])]}
    assert compute_turn_scores(run, ["a"]) == [1.0, 0.0]
