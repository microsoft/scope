# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""Pure, side-effect-free scoring of a finished Scope run.

The GEPA metric is **derived, never persisted in Scope**: Scope stores the raw
``run.turns[].criteriaResults`` and the run ``outcome``; we compute the
fraction of requested criteria that passed and aggregate it across turns.

Design decisions (see plan §C2/§D and the rubber-duck critique):

* The denominator is the number of **requested** criteria, not the number of
  results Scope happened to return. This is robust even if Scope ever omits
  skipped criteria from ``criteriaResults`` — a requested criterion with no
  passing result always counts as failed.
* ``evaluated == False`` (a DAG ancestor failed, so the criterion was skipped)
  counts as **failed**, amplifying the penalty for early failures.
* A run is scored by its criteria fraction whenever it **completed and was
  judged** — i.e. ``outcome`` is ``"succeeded"`` (all criteria passed) **or**
  ``"finished"`` (ran to ``maxIterations`` and was judged, but not all criteria
  passed). Scoring only ``"succeeded"`` runs would collapse the optimization
  landscape to ``0.0`` until a candidate passes *every* criterion, destroying
  the partial-credit gradient GEPA relies on. A run that ``"failed"`` (errored
  or abandoned the task before being judged to completion), has no turns, or has
  no judged criteria scores ``0.0``. The function never returns ``NaN``.
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence

SUCCEEDED_OUTCOME = "succeeded"
FINISHED_OUTCOME = "finished"
DONE_STATUS = "done"

# Outcomes that mean "the run completed and was judged", so its criteria
# fraction is a meaningful score. ``"failed"`` is deliberately excluded — it
# signals an error or an abandoned run with no trustworthy judgement.
SCOREABLE_OUTCOMES = frozenset({SUCCEEDED_OUTCOME, FINISHED_OUTCOME})

ScoreStrategy = str  # "mean" | "final" | "weighted"


def _turn_score(turn: Mapping[str, Any], requested_criteria: Sequence[str]) -> float:
    """Fraction of *requested* criteria that passed in a single turn."""
    results = turn.get("criteriaResults") or []
    passed_by_id: dict[str, bool] = {}
    for r in results:
        cid = r.get("criterionId")
        if cid is None:
            continue
        # A criterion only counts as passed when it was actually evaluated and
        # passed. Skipped (evaluated == False) criteria count as failed.
        passed_by_id[cid] = bool(r.get("passed")) and bool(r.get("evaluated", True))

    if requested_criteria:
        denominator = len(requested_criteria)
        passed = sum(1 for cid in requested_criteria if passed_by_id.get(cid, False))
    else:
        # No explicit request list — fall back to whatever the turn reported.
        denominator = len(passed_by_id)
        passed = sum(1 for v in passed_by_id.values() if v)

    if denominator == 0:
        return 0.0
    return passed / denominator


def compute_turn_scores(
    run: Mapping[str, Any], requested_criteria: Sequence[str]
) -> list[float]:
    """Per-turn scores for a finished run, in turn order."""
    turns = run.get("turns") or []
    return [_turn_score(t, requested_criteria) for t in turns]


def compute_run_score(
    run: Mapping[str, Any] | None,
    requested_criteria: Sequence[str],
    strategy: ScoreStrategy = "mean",
) -> float:
    """Aggregate a finished run into a single GEPA score in ``[0.0, 1.0]``.

    Returns ``0.0`` (never ``NaN``) for any run that did not complete-and-judge
    (``outcome`` not in :data:`SCOREABLE_OUTCOMES`) or produced no judged turns.
    A ``"finished"`` run (ran to completion, partial criteria) is scored by its
    criteria fraction so GEPA keeps a partial-credit gradient.
    """
    if not run:
        return 0.0
    if run.get("status") != DONE_STATUS:
        return 0.0
    if run.get("outcome") not in SCOREABLE_OUTCOMES:
        return 0.0

    turn_scores = compute_turn_scores(run, requested_criteria)
    if not turn_scores:
        return 0.0

    if strategy == "final":
        return turn_scores[-1]
    if strategy == "weighted":
        # Anchor on the final turn (the objective) but keep a small gradient
        # from the whole trajectory so partial progress is still rewarded.
        final = turn_scores[-1]
        mean = sum(turn_scores) / len(turn_scores)
        return 0.8 * final + 0.2 * mean
    # default: mean across all turns
    return sum(turn_scores) / len(turn_scores)
