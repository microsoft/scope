"""Deterministic offline report, rendered from the shared acceptance artifact."""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import sys
from pathlib import Path
from typing import Any
from urllib.parse import quote

from .quality.configuration import historical_configuration, resolve_historical_rubric
from .quality.decision import build_decision
from .quality.data import read_jsonl


def _load_object(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def _escape(value: object) -> str:
    text = html.escape(str(value)) if value is not None else ""
    for character in ("\\", "|", "[", "]", "`"):
        text = text.replace(character, "\\" + character)
    return text.replace("\n", " ").replace("\r", " ")


def _anchor(row_id: str) -> str:
    return "evidence-" + hashlib.sha256(row_id.encode()).hexdigest()[:16]


def load_decision(run_dir: Path) -> dict[str, Any]:
    """Read the shared artifact; never infer historical thresholds from today's YAML."""
    track = run_dir / "quality"
    decision = _load_object(track / "decision-summary.json")
    if not decision:
        decision = _load_object(track / "decision.json")
    if decision:
        if decision.get("schemaVersion") != 1:
            raise ValueError("unsupported decision artifact version")
        policy = decision["policy"]
        if "rubricVersion" not in policy:
            saved_summary = _load_object(track / "summary.json")
            policy["rubricVersion"] = (
                saved_summary.get("rubricVersion")
                if policy.get("sha256") and policy["sha256"] == saved_summary.get("rubricSha256") else None
            )
        return decision
    summary = _load_object(track / "summary.json")
    manifest = _load_object(run_dir / "manifest.json")
    root = Path(__file__).resolve().parents[2]
    content = resolve_historical_rubric(track, root, summary.get("rubricSha256"))
    thresholds = {}
    coverage = None
    version = None
    rubric_version = None
    if content is not None:
        configuration = historical_configuration(content, track / "rubric-snapshot.yaml")
        thresholds = {f: configuration.thresholds(f) for f in configuration.families}
        version = configuration.defaults.get("policyVersion", "historical")
        rubric_version = configuration.version
        if (track / "normalized-rows.jsonl").is_file():
            from .quality.models import NormalizedRow
            from .quality.runner import gate_coverage

            coverage = gate_coverage(
                [NormalizedRow(**r) for r in read_jsonl(track / "normalized-rows.jsonl")], configuration,
            )
    execution = (
        "running" if manifest.get("status") == "running"
        else "incomplete" if not summary or summary.get("phase") or summary.get("status") == "infrastructure-failed"
        else "completed"
    )
    decision = build_decision(
        summary.get("caseResults", []), thresholds, execution=execution,
        coverage=coverage,
        policy={"known": content is not None, "sha256": summary.get("rubricSha256"),
                "version": version, "rubricVersion": rubric_version},
    )
    decision["caveats"].append("Legacy view uses saved observations; it does not retroactively repair historical grader output.")
    if content is None:
        # Unknown is not a measured zero; clients must not present guessed totals.
        decision["totals"] = {key: None for key in decision["totals"]}
    return decision


def _rate(gate: dict[str, Any]) -> str:
    if gate["passRate"] is None:
        return "not evaluated"
    return f'{gate["passed"]}/{gate["evaluated"]} ({gate["passRate"]:.2%})'


def _requirement(gate: dict[str, Any]) -> str:
    requirement = gate["requirements"]
    parts = []
    if requirement.get("effectiveMinPassRate") is not None:
        parts.append(f'pass rate ≥ {requirement["effectiveMinPassRate"]:.2%}')
    if requirement.get("minMeanScore") is not None:
        parts.append(f'mean score ≥ {requirement["minMeanScore"]:g}')
    return "; ".join(parts)


def _score(value: Any) -> str:
    return f"{value:.3f}".rstrip("0").rstrip(".") if isinstance(value, (int, float)) else "—"


def _gate_reason(gate: dict[str, Any]) -> str:
    reasons = list(gate["violations"])
    if gate.get("coverageComplete") is False:
        reasons.append(
            f'Incomplete coverage: {gate["invalid"]} invalid or missing case assessments; '
            "a passing result cannot be established"
        )
    if not reasons:
        if gate["status"] == "passed":
            reasons.append("All configured requirements met")
        elif gate["status"] == "not-applicable":
            reasons.append("No applicable cases")
        elif gate["status"] == "unresolved":
            reasons.append("Required assessment or policy information is unavailable")
    return "; ".join(reasons)


def render_quality_report(run_dir: Path) -> str:
    manifest = _load_object(run_dir / "manifest.json")
    summary = _load_object(run_dir / "quality/summary.json")
    decision = load_decision(run_dir)
    smoke = summary.get("smoke") is True
    kind = ("offline" if summary.get("offline") else "real Azure") + (" smoke" if smoke else " full")
    if summary.get("replay"):
        kind = ("offline native-result replay (no model calls)" if summary.get("replayOffline")
                else "source-response replay (no generation)")
    counts = {key: "unknown" if value is None else value for key, value in decision["totals"].items()}
    lines = [
        f'# Static Prompt Evaluation Report: {_escape(manifest.get("runId", run_dir.name))}', "",
        f'> **Run type:** {kind}. ' + (
            "This smoke selection should not be treated as a full-dataset regression baseline."
            if smoke else "Uses the recorded case selection."
        ), "",
        f'**Execution:** {decision["execution"]} · **Acceptance:** {decision["acceptance"]} · '
        f'**Evaluator integrity:** {decision["integrity"]}', "",
        *[f'> {_escape(caveat)}' for caveat in decision["caveats"]], "",
        "## Acceptance summary", "",
        f'Blocking gates: **{counts["blockingPassed"]} passed**, **{counts["blockingFailed"]} failed**, '
        f'**{counts["blockingUnresolved"]} unresolved**, **{counts["blockingNotApplicable"]} not applicable**. '
        f'Advisory violations: **{counts["advisoryViolations"]}**.', "",
        f'Unique cases with failed verdicts: {counts["uniqueFailedCases"]}; case/evaluator failure records: '
        f'{counts["caseFailureRecords"]}. Invalid case/evaluator assessments: {counts["invalidCases"]}; '
        f'legitimately skipped case/evaluator assessments: {counts["skippedCases"]}.', "",
        "Any blocking threshold violation fails the run. Invalid grader output is unresolved, not a failed prompt. "
        "Failure can coexist with incomplete coverage; advisory failures alone do not block acceptance.", "",
        "## Family overview", "",
        "| Prompt family | Acceptance | Blocking passed | Failed | Unresolved | Not applicable | Advisory violations |",
        "|---|---|---:|---:|---:|---:|---:|",
        *[
            f'| {_escape(f["family"])} | {f["acceptance"]} | {f["blockingPassed"]} | {f["blockingFailed"]} | '
            f'{f["blockingUnresolved"]} | {f["blockingNotApplicable"]} | {f["advisoryViolations"]} |'
            for f in decision["families"]
        ], "",
        "## Gate decisions", "",
        "| Gate | Classification | Decision | Actual passing / evaluated | Required | Actual mean | Applicable / invalid / skipped | Reason |",
        "|---|---|---|---:|---|---:|---:|---|",
    ]
    gates = sorted(decision["gates"], key=lambda g: (
        g["classification"] != "blocking", {"failed": 0, "unresolved": 1, "passed": 2, "not-applicable": 3}[g["status"]],
        g["family"], g["evaluator"],
    ))
    for gate in gates:
        name = _escape(f'{gate["family"]}/{gate["evaluator"]}')
        lines.append(
            f'| [{name}](#{gate["id"]}) | {gate["classification"]} | {gate["status"]} | {_rate(gate)} | '
            f'{_escape(_requirement(gate))} | {_score(gate["meanScore"])} | '
            f'{gate["applicable"]} / {gate["invalid"]} / {gate["skipped"]} | {_escape(_gate_reason(gate))} |'
        )
    lines += [
        "", "## How to read the decisions", "",
        "Samples vote within one case using strict majority (ties fail). Cases then contribute one vote each "
        "to a gate. With one sample each, 20 passing cases out of 25 is 80%, not a binary aggregate: "
        "20/25 passes an 80% floor; 19/25 fails. Under a historical 100% floor, 24/25 fails. "
        "Individual schema/security checks remain exact. Mean-score requirements remain independent and must also pass.", "",
        "The denominator is valid evaluated cases, not samples. Applicable cases also include missing/invalid "
        "assessments; these prevent a passing gate. Legitimate non-applicable cases are counted separately. "
        "When coverage is incomplete, an aggregate failure is conclusive only if even all unknown case votes "
        "passing cannot meet the pass-rate floor. An unweighted cross-evaluator average is never an acceptance gate.", "",
        "## Gate evidence", "",
    ]
    for gate in gates:
        lines += [
            f'<a id="{gate["id"]}"></a>',
            f'### {_escape(gate["family"])} / {_escape(gate["evaluator"])}', "",
            f'{gate["classification"]}: **{gate["status"]}**; {_rate(gate)}; {_escape(_requirement(gate))}.',
            "Failed cases: " + (_escape(", ".join(gate["failedCaseIds"])) or "none"),
            "Invalid cases: " + (_escape(", ".join(gate["invalidCaseIds"])) or "none recorded; consult coverage counts"),
            "Samples: " + ", ".join(f'[{_escape(i)}](#{_anchor(i)})' for i in gate["caseEvidenceIds"]), "",
        ]
        native = Path("quality/azure-native") / gate["family"] / (gate["evaluator"] + ".json")
        # Only link inside the run, never permit a malicious family to escape it.
        candidate = (run_dir / native).resolve()
        if candidate.is_relative_to(run_dir.resolve()) and candidate.is_file():
            lines += [f'[Native evaluator output]({quote(native.as_posix(), safe="/")})', ""]
    rows_path = run_dir / "quality/normalized-rows.jsonl"
    if rows_path.is_file():
        lines += ["## Case and sample evidence", ""]
        sample_results = {}
        for result in summary.get("caseResults", []):
            for sample in result.get("samples", []):
                sample_results.setdefault(sample["rowId"], []).append((result, sample))
        for row in read_jsonl(rows_path):
            row_id = row["row_id"]
            lines += [
                f'<a id="{_anchor(row_id)}"></a>', f'### {_escape(row_id)}',
                f'Case: {_escape(row["case_id"])} · Family: {_escape(row["family"])} · Sample: {row["sample_index"]}',
                "[Original responses](quality/production-rows.jsonl) · [Normalized inputs](quality/normalized-rows.jsonl)", "",
            ]
            results = sample_results.get(row_id, [])
            if results:
                lines += ["| Evaluator | Case verdict | Sample verdict | Score / label | Reason |",
                          "|---|---|---|---|---|"]
                for result, sample in results:
                    lines.append(
                        f'| {_escape(result["evaluator"])} | {_escape(result["casePassed"])} | '
                        f'{_escape(sample.get("passed"))} | {_escape(sample.get("score"))} / '
                        f'{_escape(sample.get("label"))} | {_escape(sample.get("reason"))} |'
                    )
                lines.append("")
    findings = _load_object(run_dir / "quality/findings.json").get("findings", [])
    lines += ["## Findings and diagnostic reasons", "",
              "| Case ID | Family | Evaluator | Kind | Reason |", "|---|---|---|---|---|"]
    for finding in sorted(findings, key=lambda f: (f.get("kind") != "threshold", str(f.get("caseId", "")))):
        lines.append(f'| {_escape(finding.get("caseId"))} | {_escape(finding.get("family"))} | {_escape(finding.get("evaluator"))} | '
                     f'{_escape(finding.get("kind"))} | {_escape(finding.get("reason"))} |')
        for sample in finding.get("samples", []):
            if sample.get("reason"):
                lines.append(f'| {_escape(sample.get("rowId"))} | | | sample | {_escape(sample["reason"])} |')
    lines += [
        "", "## Run metadata", "",
        "Raw statuses are retained for compatibility: run status combines independent track exits; "
        "quality status prioritizes infrastructure failures over policy failures. The decision above "
        "separates execution, acceptance, and integrity.", "",
        "| Field | Value |", "|---|---|",
        f'| Run status | {_escape(manifest.get("status"))} |',
        f'| Quality status | {_escape(summary.get("status"))} |',
        f'| Policy status | {_escape(summary.get("policyStatus"))} |',
        f'| Policy hash | {_escape(decision["policy"].get("sha256"))} |',
        f'| Cases | {_escape(summary.get("caseCount"))} |',
        f'| Samples per case | {_escape(summary.get("samples"))} |',
        f'| Evaluator deployment | {_escape(summary.get("evaluatorDeployment"))} |',
        *[f'| Track {_escape(name)} | {_escape(track.get("status"))} |'
          for name, track in sorted(manifest.get("tracks", {}).items())],
        "", "## Source artifacts", "",
        *(
            ["- [Shared decision](quality/decision-summary.json)"]
            if (run_dir / "quality/decision-summary.json").is_file()
            else ["- [Shared decision (previous filename)](quality/decision.json)"]
            if (run_dir / "quality/decision.json").is_file()
            else ["- Shared decision: historical view; export with `--decision-output PATH --decision-only`."]
        ),
        "- [Summary](quality/summary.json)",
        "- [Findings](quality/findings.json)",
        "- [Run manifest](manifest.json)", "",
    ]
    return "\n".join(lines)


def write_quality_report(run_dir: Path, output: Path | None = None) -> Path:
    run_dir = run_dir.resolve()
    report_path = output.resolve() if output else run_dir / "REPORT.md"
    if report_path.exists() and not any(
        (run_dir / "quality" / name).exists() for name in ("decision-summary.json", "decision.json")
    ):
        raise ValueError("preserve historical REPORT.md; supply a new --output path")
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report = render_quality_report(run_dir)
    if report_path.parent != run_dir:
        prefix = quote(os.path.relpath(run_dir, report_path.parent), safe="/")
        report = report.replace("](quality/", f"]({prefix}/quality/")
        report = report.replace("](manifest.json)", f"]({prefix}/manifest.json)")
    report_path.write_text(report, encoding="utf-8")
    return report_path


def export_decision(run_dir: Path, destination: Path) -> Path:
    """Export a legacy/shared decision without writing anything in the source run."""
    run_dir = run_dir.resolve()
    destination = destination.resolve()
    if destination.is_relative_to(run_dir):
        raise ValueError("--decision-output must be outside the source run")
    decision = load_decision(run_dir)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("x", encoding="utf-8") as stream:
        json.dump(decision, stream, indent=2, sort_keys=True)
        stream.write("\n")
    return destination


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run_dir", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--decision-output", type=Path, help="Export the shared legacy decision to a NEW file")
    parser.add_argument("--decision-only", action="store_true",
                        help="Only export --decision-output; do not create or modify REPORT.md")
    args = parser.parse_args([argument for argument in sys.argv[1:] if argument != "--"])
    if args.decision_only and (not args.decision_output or args.output):
        parser.error("--decision-only requires --decision-output and cannot combine with --output")
    if args.decision_output:
        print(export_decision(args.run_dir, args.decision_output))
    if args.decision_only:
        return
    print(write_quality_report(args.run_dir, args.output))


if __name__ == "__main__":
    main()
