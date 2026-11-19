"""Immutable-source replay: offline reparse and explicitly selected Azure regrades."""

from __future__ import annotations

import hashlib
import json
import shutil
import shlex
import sys
from pathlib import Path
from typing import Any

from ..artifacts import write_json
from .aggregate import aggregate_quality
from .azure import (
    applicable_rows, evaluator_column_mapping, load_azure_runtime,
    parse_native_result, run_azure_evaluations,
)
from .configuration import (
    historical_configuration, load_quality_configuration, resolve_historical_rubric,
)
from .data import normalize_rows, read_jsonl, stable_text, write_jsonl
from .deterministic import evaluate_deterministic
from .models import EvaluatorRunOutcome, MetricObservation, NormalizedRow


def digest(value: Any) -> str:
    return hashlib.sha256(stable_text(value).encode()).hexdigest()


def file_hashes(root: Path) -> dict[str, str]:
    return {
        p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(root.rglob("*")) if p.is_file()
    }


def _projection(row: dict[str, Any], spec: dict[str, Any]) -> dict[str, Any]:
    return {argument: row.get(source.removeprefix("${data.").removesuffix("}"))
            for argument, source in evaluator_column_mapping(spec).items()}


def run_source_replay(config, track_dir, *, evaluate_callable=None, azure_runtime=None):
    from .runner import _outcome_index, _write_early_failure, gate_coverage

    source = config.source_run.resolve()
    if source == config.run_dir.resolve() or source in config.run_dir.resolve().parents:
        raise ValueError("replay destination must be outside the immutable source run")
    source_track = source / "quality"
    before = file_hashes(source)
    track_dir.mkdir(parents=True, exist_ok=True)
    try:
        return _replay(config, track_dir, source_track, before, evaluate_callable, azure_runtime)
    except Exception as error:
        return _write_early_failure(track_dir, phase="source-replay", error=error)
    finally:
        after = file_hashes(source)
        write_json(track_dir / "source-integrity.json", {
            "sourceRun": str(source), "unchanged": before == after,
            "before": before, "after": after, "generatorCalls": 0,
        })
        if before != after:
            raise ValueError("source run changed during replay")


def _replay(config, track_dir, source_track, source_hashes, evaluate_callable, azure_runtime):
    from .runner import _outcome_index, gate_coverage

    source_summary = json.loads((source_track / "summary.json").read_text())
    rubric = load_quality_configuration(config.package_root / "evaluators/rubrics.yaml",
                                        manifest_path=config.manifest_path)
    old_bytes = resolve_historical_rubric(source_track, config.package_root, source_summary.get("rubricSha256"))
    if old_bytes is None:
        raise ValueError("source rubric hash cannot be resolved; refusing unverified grade reuse")
    old = historical_configuration(old_bytes, source_track / "rubric-snapshot.yaml")
    (track_dir / "source-rubric-snapshot.yaml").write_bytes(old_bytes)
    (track_dir / "rubric-snapshot.yaml").write_bytes(rubric.path.read_bytes())
    for name in ("selected-cases.jsonl", "production-rows.jsonl"):
        shutil.copyfile(source_track / name, track_dir / name)
    cases = read_jsonl(track_dir / "selected-cases.jsonl")
    generated = read_jsonl(track_dir / "production-rows.jsonl")
    samples = int(source_summary["samples"])
    rows = normalize_rows(cases, generated, expected_samples=samples)
    if len(generated) != len(rows):
        raise ValueError("source response coverage is incomplete; no response generation is permitted")
    previous_rows = {r["row_id"]: r for r in read_jsonl(source_track / "normalized-rows.jsonl")}
    if len(previous_rows) != len(rows) or set(previous_rows) != {r.row_id for r in rows}:
        raise ValueError("source normalized row IDs do not match the original response set")
    # Response and case identity must be unchanged even when normalization changes.
    for row in rows:
        prior = previous_rows[row.row_id]
        if any(prior.get(k) != row.to_dict().get(k) for k in
               ("case_id", "family", "variant", "sample_index", "input", "expected", "output", "raw_response")):
            raise ValueError(f"source response or input mismatch: {row.row_id}")
    write_jsonl(track_dir / "normalized-rows.jsonl", (r.to_dict() for r in rows))
    row_identities = [{
        "rowId": r.row_id, "caseId": r.case_id, "sampleIndex": r.sample_index,
        "inputSha256": digest(r.input), "responseSha256": digest({"output": r.output, "rawResponse": r.raw_response}),
        "requestedModel": g.get("request", {}).get("model"),
        "actualModel": g.get("invocationMetadata", {}).get("model"),
        "sourceGenerationError": r.generation_error,
    } for r in rows for g in generated
        if (g.get("caseId") or g.get("id")) == r.case_id and g.get("sampleIndex", 0) == r.sample_index]
    if len(row_identities) != len(rows):
        raise ValueError("could not recover every source generator identity")
    plans = []
    specs_by_key = {}
    for family in sorted(rubric.families):
        family_rows = [r for r in rows if r.family == family]
        old_specs = {s["name"]: s for s in old.evaluator_specs(family)} if family in old.families else {}
        for spec in rubric.evaluator_specs(family):
            key = f"{family}/{spec['name']}"
            specs_by_key[key] = spec
            selected = applicable_rows(family_rows, spec)
            native_path = source_track / "azure-native" / family / f"{spec['name']}.json"
            input_path = native_path.with_name(f"{spec['name']}-input.jsonl")
            native_inputs = {r["row_id"]: r for r in read_jsonl(input_path)} if input_path.is_file() else {}
            reasons = []
            if old_specs.get(spec["name"]) != spec:
                reasons.append("grader configuration changed")
            if selected and (not native_path.is_file() or not input_path.is_file()):
                reasons.append("retained native output or input unavailable")
            old_input_hash = digest([_projection(native_inputs.get(r.row_id, {}), spec) for r in selected])
            new_input_hash = digest([_projection(r.to_dict(), spec) for r in selected])
            if old_input_hash != new_input_hash:
                reasons.append("mapped evaluator input changed")
            if selected and set(native_inputs) != {r.row_id for r in selected}:
                reasons.append("applicable row selection changed")
            action = "rerun-required" if selected and reasons else "reparse" if selected else "not-applicable"
            plans.append({
                "key": key, "family": family, "evaluator": spec["name"], "action": action,
                "reasons": reasons, "rowCount": len(selected),
                "sourceInputSha256": old_input_hash, "inputSha256": new_input_hash,
                "sourceSpecSha256": digest(old_specs.get(spec["name"])), "specSha256": digest(spec),
                "sourceArtifact": str(native_path.relative_to(source_track)) if native_path.is_file() else None,
                "nativeSha256": hashlib.sha256(native_path.read_bytes()).hexdigest() if native_path.is_file() else None,
            })
    affected = [p["key"] for p in plans if p["action"] == "rerun-required"]
    selection = set(config.regrade)
    if selection - set(affected):
        raise ValueError(f"--regrade contains unaffected or unknown graders: {sorted(selection - set(affected))}")
    if config.offline and selection:
        raise ValueError("offline replay cannot regrade")
    plan = {
        "schemaVersion": 1, "parentRunId": config.source_run.name, "sourceRun": str(config.source_run),
        "sourceHashes": source_hashes, "sourceRubricSha256": old.sha256,
        "rubricSha256": rubric.sha256, "policyVersion": rubric.defaults.get("policyVersion"),
        "generatorCalls": 0, "rowIdentities": row_identities, "caseCount": len(cases),
        "evaluatorDeployment": source_summary.get("evaluatorDeployment"),
        "implementationHashes": {name: sha for name, sha in file_hashes(Path(__file__).parent).items() if name.endswith(".py")},
        "generatorRevision": source_summary.get("generatorRevision"),
        "azureEvaluationSdkVersion": source_summary.get("azureEvaluationSdkVersion"),
        "affectedGraders": affected, "selectedGraders": sorted(selection), "evaluators": plans,
    }
    plan["regradeArgv"] = [
        sys.executable, "-m", "static_prompt_evals.cli", "--mode", "quality",
        "--source-run", str(config.source_run.resolve()), "--results-dir", str(config.run_dir.parent.resolve()),
        *[argument for key in affected for argument in ("--regrade", key)],
    ]
    plan["regradeCommand"] = shlex.join(plan["regradeArgv"])
    write_json(track_dir / "replay-plan.json", plan)
    print("Affected graders (no generation): " + ", ".join(affected), flush=True)
    if selection:
        runtime = azure_runtime or load_azure_runtime()
        if runtime.deployment != source_summary.get("evaluatorDeployment") or runtime.sdk_version != source_summary.get("azureEvaluationSdkVersion"):
            raise ValueError("selective replay requires the source evaluator deployment and SDK version")
    else:
        runtime = None
    outcomes = []
    for entry in plans:
        key, family, evaluator = entry["key"], entry["family"], entry["evaluator"]
        spec = specs_by_key[key]
        selected = applicable_rows([r for r in rows if r.family == family], spec)
        if key in selection:
            outcome = run_azure_evaluations(
                selected, family_specs={family: [spec]}, runtime=runtime,
                output_dir=track_dir / "azure-native", evaluate_callable=evaluate_callable,
                max_attempts=int(rubric.defaults.get("azureMaxAttempts", 3)),
                base_delay_seconds=float(rubric.defaults.get("azureRetryBaseSeconds", 1)),
            )[0]
            entry["provenance"] = "azure-rerun"
        elif entry["action"] == "reparse":
            native = source_track / entry["sourceArtifact"]
            destination = track_dir / entry["sourceArtifact"]
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(native, destination)
            shutil.copyfile(native.with_name(evaluator + "-input.jsonl"), destination.with_name(evaluator + "-input.jsonl"))
            diagnostic_source = native.with_name(evaluator + "-diagnostics.json")
            diagnostic_artifact = None
            diagnostics = None
            if diagnostic_source.is_file():
                diagnostic_destination = destination.with_name(evaluator + "-diagnostics.json")
                shutil.copyfile(diagnostic_source, diagnostic_destination)
                diagnostics = json.loads(diagnostic_source.read_text())
                diagnostic_artifact = str(diagnostic_destination.relative_to(track_dir))
            observations, skipped = parse_native_result(json.loads(native.read_text()), spec, selected, diagnostics)
            outcome = EvaluatorRunOutcome(
                family=family, evaluator=evaluator,
                status="infrastructure-failed" if any(o.infrastructure_error for o in observations) else "succeeded",
                artifact=entry["sourceArtifact"], observations=tuple(observations),
                error=next((o.reason for o in observations if o.passed is None), None),
                diagnostic_artifact=diagnostic_artifact,
            )
            entry["provenance"] = "native-reparse"
        elif entry["action"] == "rerun-required":
            outcome = EvaluatorRunOutcome(family, evaluator, "infrastructure-failed", None,
                                          error="Input or rubric changed; explicit Azure regrade required")
            entry["provenance"] = "unresolved-not-regraded"
        else:
            outcome = EvaluatorRunOutcome(family, evaluator, "not-applicable", None)
            entry["provenance"] = "not-applicable"
        entry["status"] = outcome.status
        outcomes.append(outcome)
        write_json(track_dir / "replay-plan.json", plan)
        write_json(track_dir / "azure-native/index.json", {"evaluators": _outcome_index(outcomes)})
        write_jsonl(track_dir / "azure-row-results.jsonl", (o.to_dict() for out in outcomes for o in out.observations))

    deterministic = evaluate_deterministic(rows, rubric.families)
    write_jsonl(track_dir / "deterministic-row-results.jsonl", (o.to_dict() for o in deterministic))
    azure_observations = [o for out in outcomes for o in out.observations]
    thresholds = {f: rubric.thresholds(f) for f in rubric.families}
    summary, findings, status = aggregate_quality(
        [*deterministic, *azure_observations], family_thresholds=thresholds,
        azure_outcomes=outcomes, model=source_summary.get("evaluatorDeployment"),
        coverage=gate_coverage(rows, rubric, outcomes),
        policy={"known": True, "version": rubric.defaults.get("policyVersion"),
                "rubricVersion": rubric.version, "sha256": rubric.sha256},
    )
    summary.update({
        "status": status, "policyStatus": status, "offline": False, "replay": True,
        "replayOffline": config.offline, "azureRerunCount": len(selection),
        "parentRunId": config.source_run.name, "samples": samples, "smoke": source_summary.get("smoke", False),
        "caseCount": len(cases), "generatedRowCount": len(rows), "generatorCalls": 0,
        "deterministicObservationCount": len(deterministic), "azureObservationCount": len(azure_observations),
        "rubricSha256": rubric.sha256, "rubricVersion": rubric.version,
        "evaluatorDeployment": source_summary.get("evaluatorDeployment"),
        "azureEvaluationSdkVersion": source_summary.get("azureEvaluationSdkVersion"),
        "generatorModel": source_summary.get("generatorModel"),
    })
    if any(i["actualModel"] is None for i in row_identities):
        summary["decision"]["caveats"].append("Some source responses did not record the actual generator model; requested model is not proof of generator identity.")
    if plan["generatorRevision"] is None:
        summary["decision"]["caveats"].append("The source did not snapshot its generator revision; lineage preserves its response hashes without inventing a revision.")
    summary["decision"]["caveats"].append("Tool-call accuracy is unresolved where the source did not retain tool traces; no traces were fabricated.")
    previous_observations = [
        MetricObservation(**r) for name in ("deterministic-row-results.jsonl", "azure-row-results.jsonl")
        for r in read_jsonl(source_track / name)
    ]
    # Isolate the policy-only delta on unchanged historical observations.
    old_decision, _, _ = aggregate_quality(
        previous_observations, family_thresholds={f: old.thresholds(f) for f in old.families},
        policy={"known": True, "version": "historical",
                                   "rubricVersion": old.version, "sha256": old.sha256},
        coverage=gate_coverage([NormalizedRow(**r) for r in previous_rows.values()], old),
    )
    policy_only, _, _ = aggregate_quality(
        previous_observations, family_thresholds=thresholds,
        policy={"known": True, "version": rubric.defaults.get("policyVersion"),
                "rubricVersion": rubric.version, "sha256": rubric.sha256},
        coverage=gate_coverage([NormalizedRow(**r) for r in previous_rows.values()], old),
    )
    write_json(track_dir / "comparison.json", {
        "parentRunId": config.source_run.name, "responseChanges": 0,
        "historicalDecision": old_decision["decision"], "policyOnlyDecision": policy_only["decision"],
        "correctedDecision": summary["decision"], "evaluatorProvenance": plans,
        "note": "Policy-only uses original observations (including old adapter defects). Corrections and new grades are not prompt improvements.",
    })
    write_json(track_dir / "decision-summary.json", summary["decision"])
    write_json(track_dir / "findings.json", {"findings": findings})
    write_json(track_dir / "summary.json", summary)
    return summary
