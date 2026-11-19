"""End-to-end static prompt quality runner."""

from __future__ import annotations

import hashlib
import json
import os
import shlex
import shutil
import subprocess
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

from ..artifacts import redact_error, write_json
from ..config import RunConfig
from .aggregate import aggregate_quality
from .azure import (
    AzureRuntime,
    EvaluateCallable,
    load_azure_runtime,
    run_azure_evaluations,
    applicable_rows,
)
from .configuration import QualityConfiguration, load_quality_configuration
from .data import normalize_rows, read_jsonl, read_quality_cases, write_jsonl
from .deterministic import evaluate_deterministic
from .models import EvaluatorRunOutcome
from .decision import build_decision


def gate_coverage(rows, configuration, outcomes=()):
    coverage = {}
    outcomes_by_key = {(o.family, o.evaluator): o for o in outcomes}
    for family in configuration.families:
        family_rows = [r for r in rows if r.family == family]
        family_ids = {r.case_id for r in family_rows}
        specs = {s["name"]: s for s in configuration.evaluator_specs(family)}
        case_metrics = {
            check.get("metric") or check["check"]
            for check in configuration.families[family].get("deterministic", [])
            if check.get("check") == "sample_diversity"
        }
        for evaluator in configuration.thresholds(family):
            spec = specs.get(evaluator)
            selected = applicable_rows(family_rows, spec) if spec else family_rows
            applicable_ids = {r.case_id for r in selected}
            optional = evaluator == "suggested_feature_novelty"
            # Missing recorded tool history cannot be called an intentional skip.
            missing = not optional and len(selected) != len(family_rows)
            outcome = outcomes_by_key.get((family, evaluator))
            expected_by_case = {}
            for row in sorted(selected if optional else family_rows, key=lambda r: r.sample_index):
                expected = expected_by_case.setdefault(row.case_id, [])
                # Diversity emits one case-level result over all samples.
                if evaluator not in case_metrics or not expected:
                    expected.append(row.row_id)
            coverage[(family, evaluator)] = {
                "applicable": len(applicable_ids) if optional else len(family_ids),
                "applicableCaseIds": sorted(applicable_ids if optional else family_ids),
                "rowIds": sorted(r.row_id for r in (selected if optional else family_rows)),
                "expectedRowIdsByCase": expected_by_case,
                "skipped": len(family_ids - applicable_ids) if optional else 0,
                "notApplicable": not family_rows or optional and not selected,
                "unresolved": missing or bool(outcome and outcome.status == "infrastructure-failed"),
            }
    return coverage

GeneratorCallable = Callable[[Path, Path, int, bool], None]


def _select_cases(
    cases: Sequence[Mapping[str, Any]], *, smoke: bool
) -> list[dict[str, Any]]:
    if not smoke:
        return [dict(case) for case in cases]
    explicit = [dict(case) for case in cases if case.get("smoke") is True]
    if explicit:
        return explicit
    selected: dict[str, dict[str, Any]] = {}
    for case in cases:
        family = str(case.get("family") or "")
        if family and family not in selected:
            selected[family] = dict(case)
    return list(selected.values())


def _default_generator(
    package_root: Path,
    dataset_path: Path,
    output_path: Path,
    samples: int,
    smoke: bool,
    offline: bool,
) -> None:
    command_template = os.environ.get("SCOPE_EVAL_GENERATOR_COMMAND")
    if command_template:
        substitutions = {
            "dataset": str(dataset_path),
            "output": str(output_path),
            "samples": str(samples),
            "smoke": "--smoke" if smoke else "",
        }
        command = [
            part.format_map(substitutions)
            for part in shlex.split(command_template)
            if part.format_map(substitutions)
        ]
    else:
        command = [
            "pnpm",
            "generate",
            "--",
            *(["--fake"] if offline else []),
            "--input",
            str(dataset_path),
            "--output",
            str(output_path),
            "--samples",
            str(samples),
        ]
    timeout_seconds = int(os.environ.get("SCOPE_EVAL_GENERATOR_TIMEOUT_SECONDS", "1800"))
    completed = subprocess.run(
        command,
        cwd=package_root,
        capture_output=True,
        check=False,
        text=True,
        timeout=timeout_seconds,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise RuntimeError(
            f"production prompt generator exited {completed.returncode}: {detail}"
        )
    if not output_path.is_file():
        raise RuntimeError(
            "production prompt generator succeeded without writing its output JSONL"
        )


def _copy_or_generate(
    config: RunConfig,
    *,
    selected_dataset_path: Path,
    generated_path: Path,
    generator: GeneratorCallable | None,
) -> None:
    pre_generated = os.environ.get("SCOPE_EVAL_GENERATED_ROWS")
    if pre_generated:
        source = Path(pre_generated).expanduser().resolve()
        if not source.is_file():
            raise ValueError(f"SCOPE_EVAL_GENERATED_ROWS does not exist: {source}")
        shutil.copyfile(source, generated_path)
        return
    if generator is not None:
        generator(
            selected_dataset_path,
            generated_path,
            config.samples,
            config.smoke,
        )
        return
    _default_generator(
        config.package_root,
        selected_dataset_path,
        generated_path,
        config.samples,
        config.smoke,
        config.offline,
    )


def _outcome_index(outcomes: Sequence[EvaluatorRunOutcome]) -> list[dict[str, Any]]:
    return [
        {
            "family": outcome.family,
            "evaluator": outcome.evaluator,
            "status": outcome.status,
            "artifact": outcome.artifact,
            "metrics": outcome.metrics,
            "error": outcome.error,
            "attempts": outcome.attempts,
            "diagnosticArtifact": outcome.diagnostic_artifact,
            "rowCount": len(outcome.observations),
        }
        for outcome in outcomes
    ]


def _dataset_metadata(dataset_path: Path) -> dict[str, Any]:
    dataset_root = dataset_path if dataset_path.is_dir() else dataset_path.parent
    if dataset_root.name == "v1":
        dataset_root = dataset_root.parent
    manifest_path = dataset_root / "manifest.json"
    if not manifest_path.is_file():
        return {"version": None, "manifestSha256": None}
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"version": None, "manifestSha256": None}
    return {
        "version": (
            manifest.get("datasetVersion")
            if isinstance(manifest, dict)
            else None
        ),
        "manifestSha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
    }


def _write_early_failure(
    track_dir: Path,
    *,
    phase: str,
    error: BaseException,
    configuration: QualityConfiguration | None = None,
) -> dict[str, Any]:
    redacted = redact_error(error)
    finding = {
        "kind": "infrastructure",
        "family": None,
        "caseId": None,
        "variant": None,
        "evaluator": None,
        "observed": phase,
        "reason": redacted,
    }
    summary = {
        "status": "infrastructure-failed",
        "phase": phase,
        "findingCount": 1,
        "rubricVersion": configuration.version if configuration else None,
        "rubricSha256": configuration.sha256 if configuration else None,
    }
    decision = build_decision(
        [], {f: configuration.thresholds(f) for f in configuration.families} if configuration else {},
        execution="incomplete", policy={"known": configuration is not None,
                                       "version": configuration.defaults.get("policyVersion") if configuration else None,
                                       "rubricVersion": configuration.version if configuration else None,
                                       "sha256": configuration.sha256 if configuration else None},
    )
    summary["decision"] = decision
    write_json(track_dir / "decision-summary.json", decision)
    write_json(track_dir / "findings.json", {"findings": [finding]})
    write_json(track_dir / "summary.json", summary)
    return summary


def run_quality_engine(
    config: RunConfig,
    track_dir: Path,
    *,
    generator: GeneratorCallable | None = None,
    evaluate_callable: EvaluateCallable | None = None,
    azure_runtime: AzureRuntime | None = None,
) -> dict[str, Any]:
    if config.source_run is not None:
        from .replay import run_source_replay

        return run_source_replay(config, track_dir, evaluate_callable=evaluate_callable, azure_runtime=azure_runtime)
    rubric_path = config.package_root / "evaluators" / "rubrics.yaml"
    try:
        quality_config = load_quality_configuration(
            rubric_path, manifest_path=config.manifest_path
        )
    except Exception as error:
        return _write_early_failure(
            track_dir, phase="configuration", error=error
        )
    track_dir.mkdir(parents=True, exist_ok=True)
    (track_dir / "rubric-snapshot.yaml").write_bytes(rubric_path.read_bytes())

    try:
        cases = _select_cases(
            read_quality_cases(config.dataset_path), smoke=config.smoke
        )
        selected_dataset_path = track_dir / "selected-cases.jsonl"
        write_jsonl(selected_dataset_path, cases)
        generated_path = track_dir / "production-rows.jsonl"
        _copy_or_generate(
            config,
            selected_dataset_path=selected_dataset_path,
            generated_path=generated_path,
            generator=generator,
        )
        generated_rows = read_jsonl(generated_path)
        normalized_rows = normalize_rows(
            cases, generated_rows, expected_samples=config.samples
        )
        write_jsonl(
            track_dir / "normalized-rows.jsonl",
            (row.to_dict() for row in normalized_rows),
        )
    except Exception as error:
        return _write_early_failure(
            track_dir,
            phase="generation",
            error=error,
            configuration=quality_config,
        )

    deterministic = evaluate_deterministic(
        normalized_rows, quality_config.families
    )
    write_jsonl(
        track_dir / "deterministic-row-results.jsonl",
        (observation.to_dict() for observation in deterministic),
    )

    family_specs = {
        family: quality_config.evaluator_specs(family)
        for family in quality_config.families
    }
    runtime_error: Exception | None = None
    if azure_runtime is None and not config.offline:
        try:
            azure_runtime = load_azure_runtime()
        except Exception as error:
            runtime_error = error

    if config.offline:
        azure_outcomes = []
        model = "fake-model"
        sdk_version = None
        auth_mode = "offline"
    elif azure_runtime is None:
        redacted = redact_error(runtime_error or RuntimeError("Azure setup failed"))
        azure_outcomes = [
            EvaluatorRunOutcome(
                family=family,
                evaluator=str(spec["name"]),
                status="infrastructure-failed",
                artifact=None,
                error=redacted,
            )
            for family, specs in family_specs.items()
            for spec in specs
        ]
        model = None
        sdk_version = None
        auth_mode = None
    else:
        azure_outcomes = run_azure_evaluations(
            normalized_rows,
            family_specs=family_specs,
            runtime=azure_runtime,
            output_dir=track_dir / "azure-native",
            evaluate_callable=evaluate_callable,
            max_attempts=int(
                quality_config.defaults.get("azureMaxAttempts", 3)
            ),
            base_delay_seconds=float(
                quality_config.defaults.get("azureRetryBaseSeconds", 1)
            ),
        )
        model = azure_runtime.deployment
        sdk_version = azure_runtime.sdk_version
        auth_mode = azure_runtime.auth_mode

    write_json(
        track_dir / "azure-native" / "index.json",
        {"evaluators": _outcome_index(azure_outcomes)},
    )
    azure_observations = [
        observation
        for outcome in azure_outcomes
        for observation in outcome.observations
    ]
    write_jsonl(
        track_dir / "azure-row-results.jsonl",
        (observation.to_dict() for observation in azure_observations),
    )

    thresholds = {
        family: quality_config.thresholds(family)
        for family in quality_config.families
    }
    summary, findings, status = aggregate_quality(
        [*deterministic, *azure_observations],
        family_thresholds=thresholds,
        azure_outcomes=azure_outcomes,
        model=model,
        coverage=gate_coverage(normalized_rows, quality_config, azure_outcomes),
        policy={"known": True, "version": quality_config.defaults.get("policyVersion"),
                "rubricVersion": quality_config.version,
                "sha256": quality_config.sha256},
    )
    policy_status = status
    if config.offline:
        status = "succeeded"
        summary["decision"]["acceptance"] = "not-evaluated"
        summary["decision"]["caveats"].append("Offline fake generation is not a production quality assessment.")
    summary.update(
        {
            "status": status,
            "policyStatus": policy_status,
            "offline": config.offline,
            "dataset": str(config.dataset_path.name),
            "datasetMetadata": _dataset_metadata(config.dataset_path),
            "samples": config.samples,
            "smoke": config.smoke,
            "caseCount": len(cases),
            "generatedRowCount": len(normalized_rows),
            "deterministicObservationCount": len(deterministic),
            "azureObservationCount": len(azure_observations),
            "rubricVersion": quality_config.version,
            "rubricSha256": quality_config.sha256,
            "azureEvaluationSdkVersion": sdk_version,
            "evaluatorDeployment": model,
            "generatorModel": (
                os.environ.get("PROMPT_EVAL_MODEL")
                or os.environ.get("LLM_MODEL")
            ),
            "authenticationMode": auth_mode,
            "artifacts": {
                "selectedCases": "selected-cases.jsonl",
                "productionRows": "production-rows.jsonl",
                "normalizedRows": "normalized-rows.jsonl",
                "deterministicRows": "deterministic-row-results.jsonl",
                "azureRows": "azure-row-results.jsonl",
                "azureNativeIndex": "azure-native/index.json",
                "findings": "findings.json",
            },
        }
    )
    write_json(track_dir / "findings.json", {"findings": findings})
    write_json(track_dir / "summary.json", summary)
    write_json(track_dir / "decision-summary.json", summary["decision"])
    return summary


def run_quality(config: RunConfig, run_dir: Path) -> dict[str, Any]:
    """Run generation, deterministic checks, Azure graders, and policy checks."""

    return run_quality_engine(config, run_dir)
