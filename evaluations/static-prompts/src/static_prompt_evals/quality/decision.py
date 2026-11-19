"""Versioned, offline acceptance decisions shared by report and review clients."""

from __future__ import annotations

import hashlib
from collections.abc import Mapping, Sequence
from typing import Any


def gate_id(family: str, evaluator: str) -> str:
    return "gate-" + hashlib.sha256(f"{family}/{evaluator}".encode()).hexdigest()[:16]


def apply_sample_coverage(
    cases: Sequence[Mapping[str, Any]],
    coverage: Mapping[tuple[str, str], Mapping[str, Any]],
) -> list[dict[str, Any]]:
    results = []
    for case in cases:
        result = dict(case)
        expected_by_case = coverage.get((case["family"], case["evaluator"]), {}).get("expectedRowIdsByCase", {})
        expected = expected_by_case.get(case["caseId"])
        if expected is not None:
            observed = {sample["rowId"] for sample in case.get("samples", [])}
            missing = set(expected) - observed
            result["expectedSampleCount"] = len(expected)
            result["missingSampleCount"] = len(missing)
            if missing:
                result.update(casePassed=None, meanScore=None, infrastructureError=True)
        if result.get("casePassed") is None:
            result["meanScore"] = None
        results.append(result)
    return results


def build_decision(
    cases: Sequence[Mapping[str, Any]],
    thresholds: Mapping[str, Mapping[str, Mapping[str, Any]]],
    *,
    coverage: Mapping[tuple[str, str], Mapping[str, Any]] | None = None,
    execution: str = "completed",
    policy: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Invalid/missing cases are unknown, never false prompt grades or passes."""
    coverage = coverage or {}
    cases = apply_sample_coverage(cases, coverage)
    gates = []
    for family, evaluators in sorted(thresholds.items()):
        for evaluator, threshold in sorted(evaluators.items()):
            records = [c for c in cases if c["family"] == family and c["evaluator"] == evaluator]
            complete = [c for c in records if c["casePassed"] is not None]
            invalid_ids = {c["caseId"] for c in records if c["casePassed"] is None}
            failed_ids = {c["caseId"] for c in complete if c["casePassed"] is False}
            counts = coverage.get((family, evaluator), {})
            invalid_ids.update(set(counts.get("applicableCaseIds", [])) - {c["caseId"] for c in complete})
            skipped = int(counts.get("skipped", 0))
            applicable = int(counts.get("applicable", len(records)))
            invalid = max(len(invalid_ids), applicable - len(complete))
            passed = sum(c["casePassed"] is True for c in complete)
            rate = passed / len(complete) if complete else None
            scores = [c["meanScore"] for c in complete if c.get("meanScore") is not None]
            mean = sum(scores) / len(scores) if scores else None
            requirements = dict(threshold)
            required = threshold.get("minPassRate")
            baseline = threshold.get("baselinePassRate")
            regression = threshold.get("maxRegression")
            if baseline is not None and regression is not None:
                derived = float(baseline) - float(regression)
                required = max(float(required or 0), derived)
                requirements["baselineDerivedMinPassRate"] = derived
            if required is not None:
                required = float(required)
            requirements["effectiveMinPassRate"] = required
            floor = requirements["effectiveMinPassRate"]
            violations = []
            # With incomplete coverage, failed observed cases alone cannot establish
            # an aggregate failure. Use the best possible completion as the bound.
            best_rate = (passed + invalid) / applicable if applicable else rate
            if floor is not None and rate is not None and rate < floor:
                if not invalid or (best_rate is not None and best_rate < floor):
                    violations.append(f"pass rate {passed}/{len(complete)} ({rate:.2%}) below required {floor:.2%}")
            minimum_mean = threshold.get("minMeanScore")
            if minimum_mean is not None and mean is not None and mean < minimum_mean and not invalid:
                violations.append(f"mean score {mean:g} below required {minimum_mean:g}")
            legitimate_skip = counts.get("notApplicable") is True and applicable == 0
            missing = (
                invalid > 0 or counts.get("unresolved") is True
                or not complete and not legitimate_skip
                or minimum_mean is not None and len(scores) != len(complete)
            )
            status = (
                "failed" if violations else "unresolved" if missing
                else "not-applicable" if legitimate_skip else "passed"
            )
            gates.append({
                "id": gate_id(family, evaluator), "family": family, "evaluator": evaluator,
                "classification": "blocking" if threshold.get("blocking", True) else "advisory",
                "status": status, "passed": passed, "evaluated": len(complete),
                "applicable": applicable, "skipped": skipped, "invalid": invalid,
                "coverageComplete": not missing, "passRate": rate, "meanScore": mean,
                "requirements": requirements, "violations": violations,
                "caseEvidenceIds": sorted(
                    {s["rowId"] for c in records for s in c.get("samples", [])}
                    | set(counts.get("rowIds", []))
                ),
                "failedCaseIds": sorted(failed_ids), "invalidCaseIds": sorted(invalid_ids),
            })

    def totals(items: list[dict[str, Any]]) -> dict[str, int]:
        result = {
            "blocking" + key: sum(g["classification"] == "blocking" and g["status"] == status for g in items)
            for key, status in [("Passed", "passed"), ("Failed", "failed"), ("Unresolved", "unresolved"), ("NotApplicable", "not-applicable")]
        }
        result["advisoryViolations"] = sum(g["classification"] == "advisory" and g["status"] == "failed" for g in items)
        return result

    known = policy is None or policy.get("known", True)
    def acceptance(items: list[dict[str, Any]]) -> str:
        blocking = [g for g in items if g["classification"] == "blocking"]
        if any(g["status"] == "failed" for g in blocking):
            return "failed"
        if execution != "completed" or not known or any(g["status"] == "unresolved" for g in blocking):
            return "undetermined"
        return "passed" if any(g["status"] == "passed" for g in blocking) else "not-evaluated"

    counts = totals(gates)
    counts.update({
        "uniqueFailedCases": len({c for g in gates for c in g["failedCaseIds"]}),
        "caseFailureRecords": sum(c["casePassed"] is False for c in cases),
        "invalidCases": sum(g["invalid"] for g in gates),
        "skippedCases": sum(g["skipped"] for g in gates),
    })
    if not known:
        counts = {key: None for key in counts}
    incomplete = execution != "completed" or any(not g["coverageComplete"] for g in gates)
    return {
        "schemaVersion": 1, "execution": execution, "acceptance": acceptance(gates),
        "integrity": "unknown" if not known else "incomplete" if incomplete else "valid",
        "policy": {"version": None, "rubricVersion": None,
                   "sha256": None, "known": True, **dict(policy or {})},
        "totals": counts,
        "families": [
            {"family": f, "acceptance": acceptance(items), **totals(items)}
            for f in sorted(thresholds)
            for items in [[g for g in gates if g["family"] == f]]
        ],
        "gates": gates,
        "caveats": (
            ["Historical policy is unavailable: gate totals and acceptance are unknown."] if not known else []
        ) + (["Assessment has missing or invalid coverage; this is not a prompt failure."] if incomplete else []),
    }
