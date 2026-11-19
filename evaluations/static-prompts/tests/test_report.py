import json
import pytest
import hashlib
import sys
from pathlib import Path

from static_prompt_evals.report import render_quality_report, write_quality_report
from static_prompt_evals.report import load_decision, export_decision, main
from static_prompt_evals.quality.decision import build_decision


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def test_render_quality_report_describes_smoke_scope_and_findings(
    tmp_path: Path,
) -> None:
    _write_json(
        tmp_path / "manifest.json",
        {
            "runId": "run-1",
            "mode": "quality",
            "status": "failed",
            "startedAt": "2026-01-01T00:00:00Z",
            "completedAt": "2026-01-01T00:01:00Z",
        },
    )
    _write_json(
        tmp_path / "quality" / "summary.json",
        {
            "status": "failed",
            "policyStatus": "failed",
            "smoke": True,
            "offline": False,
            "caseCount": 1,
            "generatedRowCount": 1,
            "samples": 1,
            "azureObservationCount": 1,
            "deterministicObservationCount": 1,
            "findingCount": 1,
            "evaluatorDeployment": "model",
            "azureEvaluationSdkVersion": "1.18.5",
            "aggregates": {
                "byFamily": [
                    {
                        "family": "criteria-authoring",
                        "caseCount": 1,
                        "passRate": 0.0,
                        "infrastructureErrorCount": 0,
                    }
                ]
            },
        },
    )
    _write_json(
        tmp_path / "quality" / "findings.json",
        {
            "findings": [
                {
                    "family": "criteria-authoring",
                    "variant": "default",
                    "evaluator": "quality",
                    "kind": "case-failure",
                    "reason": "Needs | stronger grounding",
                    "observed": {
                        "meanScore": 2.0,
                        "passCount": 0,
                        "sampleCount": 1,
                    },
                }
            ]
        },
    )

    report = render_quality_report(tmp_path)

    assert "**Run type:** real Azure smoke" in report
    assert "should not be treated as a full-dataset" in report
    assert "criteria-authoring" in report
    assert "Needs \\| stronger grounding" in report
    assert "Evaluator integrity:** unknown" in report
    assert "gate totals and acceptance are unknown" in report
    assert "Mean evaluator pass rate" not in report
    assert "Any blocking threshold violation fails the run" in report


def test_write_quality_report_defaults_inside_run_directory(
    tmp_path: Path,
) -> None:
    _write_json(tmp_path / "manifest.json", {"runId": "run-1"})
    _write_json(
        tmp_path / "quality" / "summary.json",
        {"aggregates": {"byFamily": []}},
    )
    _write_json(tmp_path / "quality" / "findings.json", {"findings": []})

    output = write_quality_report(tmp_path)

    assert output == tmp_path / "REPORT.md"
    assert output.read_text(encoding="utf-8").startswith(
        "# Static Prompt Evaluation Report"
    )


def test_report_uses_shared_decision_and_escapes_case_ids(tmp_path):
    decision = build_decision(
        [{"family": "family", "evaluator": "schema", "caseId": "case|[x]",
          "casePassed": False, "meanScore": None,
          "samples": [{"rowId": "case|[x]::sample-0"}]}],
        {"family": {"schema": {"minPassRate": 0.8}}},
    )
    _write_json(tmp_path / "quality/decision-summary.json", decision)
    _write_json(tmp_path / "manifest.json", {"runId": "<unsafe>"})
    report = render_quality_report(tmp_path)
    assert "**Acceptance:** failed" in report
    assert "**1 failed**" in report
    assert "0/1 (0.00%)" in report and "80.00%" in report
    assert "case\\|\\[x\\]" in report
    assert "&lt;unsafe&gt;" in report
    assert load_decision(tmp_path) == decision


def test_changed_rubric_hash_never_uses_current_thresholds(tmp_path):
    _write_json(tmp_path / "quality/summary.json", {"rubricSha256": "does-not-match", "status": "succeeded"})
    decision = load_decision(tmp_path)
    assert decision["integrity"] == "unknown"
    assert decision["acceptance"] == "undetermined"
    assert decision["totals"]["blockingPassed"] is None


def test_historical_report_cannot_be_overwritten(tmp_path):
    (tmp_path / "REPORT.md").write_text("original")
    with pytest.raises(ValueError, match="preserve historical"):
        write_quality_report(tmp_path)
    assert (tmp_path / "REPORT.md").read_text() == "original"


def test_hash_matching_historical_snapshot_preserves_hundred_percent(tmp_path):
    content = b"""version: 1
defaults: {}
graders: {}
families:
  family:
    thresholds:
      schema: {minPassRate: 1.0}
"""
    quality = tmp_path / "quality"
    quality.mkdir()
    (quality / "rubric-snapshot.yaml").write_bytes(content)
    _write_json(quality / "summary.json", {
        "rubricSha256": hashlib.sha256(content).hexdigest(),
        "caseResults": [{"family": "family", "evaluator": "schema", "caseId": f"case-{i}",
                         "casePassed": i < 24, "meanScore": None, "samples": []} for i in range(25)],
    })
    report = render_quality_report(tmp_path)
    decision = load_decision(tmp_path)
    assert decision["gates"][0]["requirements"]["effectiveMinPassRate"] == 1.0
    assert decision["acceptance"] == "failed"
    assert "24/25 (96.00%)" in report
    assert "pass rate ≥ 100.00%" in report


def test_report_output_elsewhere_keeps_artifact_links_pointing_to_source(tmp_path):
    run = tmp_path / "source"
    run.mkdir()
    output = tmp_path / "preview.md"
    write_quality_report(run, output)
    assert "](source/quality/summary.json)" in output.read_text()


@pytest.mark.parametrize("separator", [[], ["--"]], ids=["direct-python", "pnpm-forwarded-separator"])
def test_decision_only_exports_legacy_without_touching_source(tmp_path, monkeypatch, separator):
    source = tmp_path / "source--run"
    source.mkdir()
    (source / "REPORT.md").write_text("immutable original report")
    _write_json(source / "quality/summary.json", {"status": "failed", "rubricSha256": "unknown"})
    before = {p.relative_to(source): p.read_bytes() for p in source.rglob("*") if p.is_file()}
    output = tmp_path / "external/quality/decision-summary.json"
    monkeypatch.setattr(sys, "argv", ["report", *separator, str(source), "--decision-output", str(output), "--decision-only"])
    main()
    decision = json.loads(output.read_text())
    assert decision["integrity"] == "unknown"
    assert decision["totals"]["blockingPassed"] is None
    assert before == {p.relative_to(source): p.read_bytes() for p in source.rglob("*") if p.is_file()}
    with pytest.raises(FileExistsError):
        export_decision(source, output)
    with pytest.raises(ValueError, match="outside"):
        export_decision(source, source / "quality/decision-summary.json")


def test_canonical_decision_takes_precedence_over_previous_filename(tmp_path):
    canonical = build_decision([], {}, execution="incomplete")
    old = build_decision([], {}, execution="completed")
    _write_json(tmp_path / "quality/decision-summary.json", canonical)
    _write_json(tmp_path / "quality/decision.json", old)
    assert load_decision(tmp_path) == canonical


def test_gate_table_explains_unresolved_coverage_and_formats_scores(tmp_path):
    decision = build_decision(
        [{"family": "family", "evaluator": "quality", "caseId": "case-1",
          "casePassed": True, "meanScore": 4.333333333333333,
          "samples": [{"rowId": "case-1::sample-0"}]}],
        {"family": {"quality": {"minPassRate": 0.8}}},
    )
    gate = decision["gates"][0]
    gate.update(status="unresolved", coverageComplete=False, invalid=1, applicable=2)
    _write_json(tmp_path / "quality/decision-summary.json", decision)
    report = render_quality_report(tmp_path)
    assert "4.333 |" in report
    assert "4.333333333333333" not in report
    assert "Incomplete coverage: 1 invalid or missing case assessments" in report
