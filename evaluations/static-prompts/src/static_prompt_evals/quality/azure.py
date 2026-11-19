"""Azure AI Evaluation SDK evaluator construction and orchestration."""

from __future__ import annotations

import os
import json
import math
import logging
import random
import re
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any

from ..artifacts import redact_error, write_json
from .data import first_path, stable_text, write_jsonl
from .models import EvaluatorRunOutcome, MetricObservation, NormalizedRow

EvaluateCallable = Callable[..., Mapping[str, Any]]

_BUILTIN_ARGUMENTS: dict[str, tuple[str, ...]] = {
    "relevance": ("query", "response"),
    "coherence": ("query", "response"),
    "fluency": ("response",),
    "groundedness": ("query", "response", "context"),
    "intent_resolution": ("query_messages", "response_messages"),
    "task_adherence": ("query_messages", "response_messages"),
    "tool_call_accuracy": (
        "query_messages",
        "tool_definitions",
        "tool_calls",
        "response_messages",
    ),
}
_TRANSIENT_STATUS_CODES = {408, 429, 500, 502, 503, 504}
_TRANSIENT_MARKERS = (
    "connection reset",
    "connection aborted",
    "connection refused",
    "rate limit",
    "temporarily unavailable",
    "timed out",
    "timeout",
    "too many requests",
)


@dataclass(frozen=True)
class AzureRuntime:
    model_config: dict[str, Any]
    credential: Any
    project: str | None
    deployment: str
    sdk_version: str
    auth_mode: str


class _SdkDiagnostics(logging.Handler):
    """Retain the pinned SDK's run summary, which evaluate() omits from its return."""

    def __init__(self, evaluator: str):
        super().__init__()
        self.evaluator = evaluator
        self.summary: dict[str, Any] = {}

    def emit(self, record: logging.LogRecord) -> None:
        message = record.getMessage()
        if not message.startswith("run_summary:"):
            return
        try:
            summaries = json.loads(message.partition(":")[2])
        except (ValueError, TypeError):
            return
        summary = summaries.get(self.evaluator) if isinstance(summaries, dict) else None
        if isinstance(summary, dict):
            self.summary = summary

    def payload(self, family: str, rows: Sequence[NormalizedRow], sdk_version: str) -> dict[str, Any]:
        summary = {key: self.summary.get(key) for key in (
            "status", "completed_lines", "failed_lines", "error_code",
        )}
        message = self.summary.get("error_message")
        summary["error_message"] = redact_error(RuntimeError(str(message))) if message else None
        line_errors = self.summary.get("per_line_errors") or {}
        summary["per_line_errors"] = {
            str(index): redact_error(RuntimeError(str(error)))
            for index, error in line_errors.items()
        } if isinstance(line_errors, Mapping) else {}
        return {
            "schemaVersion": 1, "family": family, "evaluator": self.evaluator,
            "azureEvaluationSdkVersion": sdk_version, "runSummary": summary,
            "error": summary["error_message"],
            "rowErrors": {
                row.row_id: summary["per_line_errors"][str(index)]
                for index, row in enumerate(rows) if str(index) in summary["per_line_errors"]
            },
        }


def validate_sdk_input(evaluator: Any, spec: Mapping[str, Any], row: NormalizedRow) -> None:
    """Run the real SDK validator and converter, without invoking the model."""
    validator = getattr(evaluator, "_validator", None)
    if str(spec.get("type") or "builtin") != "builtin" or validator is None:
        return
    source = row.to_dict()
    arguments = {
        argument: source[column.removeprefix("${data.").removesuffix("}")]
        for argument, column in evaluator_column_mapping(spec).items()
    }
    validator.validate_eval_input(arguments)
    converter = getattr(evaluator, "_convert_kwargs_to_eval_input", None)
    if converter is not None:
        converted = converter(**arguments)
        for item in converted if isinstance(converted, list) else [converted]:
            if not isinstance(item, Mapping):
                raise ValueError("SDK converter returned an invalid input shape")
            if item.get("error_message"):
                raise ValueError(str(item["error_message"]))
            validator.validate_eval_input(item)


def _environment(
    env: Mapping[str, str], primary: str, fallback: str | None = None
) -> str | None:
    value = env.get(primary)
    if value:
        return value
    return env.get(fallback) if fallback else None


def load_azure_runtime(env: Mapping[str, str] | None = None) -> AzureRuntime:
    environ = env or os.environ
    endpoint = _environment(
        environ, "SCOPE_EVAL_AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_ENDPOINT"
    )
    deployment = _environment(
        environ,
        "SCOPE_EVAL_AZURE_OPENAI_DEPLOYMENT",
        "AZURE_OPENAI_DEPLOYMENT",
    )
    api_key = _environment(
        environ, "SCOPE_EVAL_AZURE_OPENAI_API_KEY", "AZURE_OPENAI_API_KEY"
    )
    api_version = _environment(
        environ,
        "SCOPE_EVAL_AZURE_OPENAI_API_VERSION",
        "AZURE_OPENAI_API_VERSION",
    )
    project = _environment(
        environ,
        "SCOPE_EVAL_AZURE_AI_PROJECT_ENDPOINT",
        "AZURE_AI_PROJECT_ENDPOINT",
    )
    if not endpoint:
        raise ValueError(
            "SCOPE_EVAL_AZURE_OPENAI_ENDPOINT or AZURE_OPENAI_ENDPOINT is required"
        )
    if not deployment:
        raise ValueError(
            "SCOPE_EVAL_AZURE_OPENAI_DEPLOYMENT or AZURE_OPENAI_DEPLOYMENT "
            "is required"
        )

    model_config: dict[str, Any] = {
        "azure_endpoint": endpoint,
        "azure_deployment": deployment,
    }
    credential: Any = None
    auth_mode = "api-key"
    if api_key:
        model_config["api_key"] = api_key
    else:
        from azure.identity import DefaultAzureCredential

        credential = DefaultAzureCredential(
            exclude_interactive_browser_credential=True
        )
        auth_mode = "default-azure-credential"
    if api_version:
        model_config["api_version"] = api_version
    try:
        sdk_version = version("azure-ai-evaluation")
    except PackageNotFoundError:
        sdk_version = "unknown"
    return AzureRuntime(
        model_config=model_config,
        credential=credential,
        project=project,
        deployment=deployment,
        sdk_version=sdk_version,
        auth_mode=auth_mode,
    )


def _builtins() -> dict[str, type[Any]]:
    from azure.ai.evaluation import (
        CoherenceEvaluator,
        FluencyEvaluator,
        GroundednessEvaluator,
        IntentResolutionEvaluator,
        RelevanceEvaluator,
        TaskAdherenceEvaluator,
        ToolCallAccuracyEvaluator,
    )

    return {
        "relevance": RelevanceEvaluator,
        "coherence": CoherenceEvaluator,
        "fluency": FluencyEvaluator,
        "groundedness": GroundednessEvaluator,
        "intent_resolution": IntentResolutionEvaluator,
        "task_adherence": TaskAdherenceEvaluator,
        "tool_call_accuracy": ToolCallAccuracyEvaluator,
    }


def create_evaluator(spec: Mapping[str, Any], runtime: AzureRuntime) -> Any:
    name = str(spec["name"])
    evaluator_type = str(spec.get("type") or "builtin")
    if evaluator_type == "builtin":
        evaluator_class = _builtins().get(name)
        if evaluator_class is None:
            raise ValueError(f"unsupported Azure built-in evaluator: {name}")
        kwargs: dict[str, Any] = {}
        if runtime.credential is not None:
            kwargs["credential"] = runtime.credential
        if spec.get("scorePassThreshold") is not None:
            kwargs["threshold"] = spec["scorePassThreshold"]
        if runtime.deployment.casefold().startswith(("gpt-5", "o1", "o3", "o4")):
            kwargs["is_reasoning_model"] = True
        return evaluator_class(runtime.model_config, **kwargs)

    prompt = str(spec["prompt"]).strip()
    rubric_context = (
        "Query:\n{{item.query}}\n\n"
        "Response:\n{{item.response}}\n\n"
        "Expected behavior:\n{{item.expected_behavior}}\n\n"
        "Evidence context:\n{{item.context}}"
    )
    if not spec.get("excludeGroundTruth", False):
        rubric_context += "\n\nReviewed ground truth:\n{{item.ground_truth}}"
    grader_input = [
        {"role": "system", "content": prompt},
        {"role": "user", "content": rubric_context},
    ]
    common: dict[str, Any] = {
        "model_config": runtime.model_config,
        "input": grader_input,
        "model": runtime.deployment,
        "name": name,
    }
    if runtime.credential is not None:
        common["credential"] = runtime.credential
    if evaluator_type == "score":
        from azure.ai.evaluation import AzureOpenAIScoreModelGrader

        return AzureOpenAIScoreModelGrader(
            **common,
            range=list(spec.get("range", [1, 5])),
            pass_threshold=float(spec.get("scorePassThreshold", 3)),
            sampling_params={"temperature": 0},
        )
    if evaluator_type == "label":
        from azure.ai.evaluation import AzureOpenAILabelGrader

        return AzureOpenAILabelGrader(
            **common,
            labels=list(spec["labels"]),
            passing_labels=list(spec["passingLabels"]),
        )
    raise ValueError(f"unsupported evaluator type {evaluator_type!r} for {name!r}")


def evaluator_column_mapping(spec: Mapping[str, Any]) -> dict[str, str]:
    name = str(spec["name"])
    evaluator_type = str(spec.get("type") or "builtin")
    if evaluator_type == "builtin":
        arguments = _BUILTIN_ARGUMENTS.get(name)
        if arguments is None:
            raise ValueError(f"unsupported Azure built-in evaluator: {name}")
        source_names = {
            "query_messages": "query",
            "response_messages": "response",
        }
        return {
            source_names.get(argument, argument): f"${{data.{argument}}}"
            for argument in arguments
        }
    return {
        name: f"${{data.{name}}}"
        for name in (
            "query",
            "response",
            "expected_behavior",
            "context",
            "ground_truth",
        )
    }


def sdk_row(row: NormalizedRow) -> dict[str, Any]:
    payload = row.to_dict()
    payload["expected_labels_text"] = stable_text(row.expected_labels)
    return payload


def _value_present(value: Any) -> bool:
    return value not in (None, "", [], {})


def applicable_rows(
    rows: Sequence[NormalizedRow], spec: Mapping[str, Any]
) -> list[NormalizedRow]:
    configured = spec.get("requiredFields")
    if isinstance(configured, str):
        required_fields = (configured,)
    elif isinstance(configured, Sequence):
        required_fields = tuple(str(field) for field in configured)
    else:
        name = str(spec["name"])
        required_fields = _BUILTIN_ARGUMENTS.get(name, ())
    return [
        row
        for row in rows
        if not row.infrastructure_error
        and not row.generation_error
        and all(_value_present(first_path(row.to_dict(), (field,))) for field in required_fields)
    ]


def is_transient_error(error: BaseException) -> bool:
    status_code = getattr(error, "status_code", None)
    if status_code in _TRANSIENT_STATUS_CODES:
        return True
    response = getattr(error, "response", None)
    if getattr(response, "status_code", None) in _TRANSIENT_STATUS_CODES:
        return True
    message = str(error).casefold()
    return any(marker in message for marker in _TRANSIENT_MARKERS)


def evaluate_with_retry(
    operation: Callable[[], Mapping[str, Any]],
    *,
    max_attempts: int,
    base_delay_seconds: float,
    sleep: Callable[[float], None] = time.sleep,
) -> tuple[Mapping[str, Any], int]:
    if max_attempts < 1:
        raise ValueError("max_attempts must be at least one")
    for attempt in range(1, max_attempts + 1):
        try:
            return operation(), attempt
        except Exception as error:
            if attempt == max_attempts or not is_transient_error(error):
                raise
            delay = min(base_delay_seconds * (2 ** (attempt - 1)), 30.0)
            sleep(delay + random.uniform(0, max(delay * 0.1, 0.001)))
    raise AssertionError("retry loop terminated unexpectedly")


def _result_value(
    result_row: Mapping[str, Any],
    evaluator: str,
    suffixes: Sequence[str],
) -> Any:
    prefix = f"outputs.{evaluator}."
    for suffix in suffixes:
        exact = prefix + suffix
        if exact in result_row:
            return result_row[exact]
    return None


def _sample_result(result_row: Mapping[str, Any], evaluator: str) -> tuple[Any, str]:
    sample = _result_value(result_row, evaluator, ("sample",))
    if sample is None:
        return None, ""
    if not isinstance(sample, Mapping) or not isinstance(sample.get("output"), list):
        raise ValueError("malformed SDK grader sample")
    outputs = sample["output"]
    messages = [m for m in outputs if isinstance(m, Mapping) and m.get("role") == "assistant"]
    if len(messages) != 1 or not isinstance(messages[0].get("content"), str):
        raise ValueError("expected one structured assistant grader output")
    parsed = json.loads(messages[0]["content"])
    if not isinstance(parsed, Mapping) or "result" not in parsed:
        raise ValueError("structured grader output has no result")
    steps = parsed.get("steps", [])
    if not isinstance(steps, list) or any(not isinstance(s, Mapping) for s in steps):
        raise ValueError("invalid structured grader reasoning")
    reason = "; ".join(str(s.get("conclusion") or s.get("description") or "") for s in steps)
    return parsed["result"], reason


def _canonical_label(evaluator: str, value: Any) -> Any:
    if evaluator == "criteria_evidence_source" and value == "tool-history":
        return "tool_history"
    return value


def _as_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and value in (0, 1):
        return bool(value)
    if isinstance(value, str):
        normalized = value.casefold()
        if normalized in {"pass", "passed", "true", "1"}:
            return True
        if normalized in {"fail", "failed", "false", "0"}:
            return False
    return None


def _is_skipped_result(result_row: Mapping[str, Any], evaluator: str) -> bool:
    status = _result_value(
        result_row, evaluator, ("status", f"{evaluator}_status")
    )
    result = _result_value(
        result_row, evaluator, ("result", f"{evaluator}_result")
    )
    return (
        isinstance(status, str)
        and status.casefold() == "skipped"
        or isinstance(result, str)
        and result.casefold() == "not_applicable"
    )


def observation_from_sdk_row(
    evaluator: str,
    spec: Mapping[str, Any],
    result_row: Mapping[str, Any],
    source_row: NormalizedRow,
) -> MetricObservation:
    error_value = _result_value(
        result_row, evaluator, ("error", "error_message", "_error")
    )
    if error_value not in (None, ""):
        return MetricObservation(
            row_id=source_row.row_id,
            case_id=source_row.case_id,
            family=source_row.family,
            variant=source_row.variant,
            source_category=source_row.source_category,
            sample_index=source_row.sample_index,
            evaluator=evaluator,
            passed=None,
            reason=redact_error(RuntimeError(str(error_value))),
            infrastructure_error=True,
        )

    invalid_reason = ""
    try:
        structured, structured_reason = _sample_result(result_row, evaluator)
    except (ValueError, TypeError) as error:
        structured, structured_reason = None, ""
        invalid_reason = str(error)
    raw_score = _result_value(
        result_row,
        evaluator,
        ("score", f"{evaluator}_score", evaluator),
    )
    if spec.get("type") == "score" and structured is not None:
        raw_score = structured
    try:
        score = float(raw_score) if raw_score is not None else None
    except (TypeError, ValueError):
        score = None
    raw_label = _result_value(result_row, evaluator, ("label",))
    if spec.get("type") == "label" and structured is not None:
        raw_label = structured
    label = _canonical_label(evaluator, raw_label) if isinstance(raw_label, str) else None
    reason = str(
        _result_value(result_row, evaluator, ("reason", f"{evaluator}_reason"))
        or structured_reason
    )
    passed = _as_bool(
        _result_value(
            result_row,
            evaluator,
            ("passed", "result", f"{evaluator}_passed", f"{evaluator}_result"),
        )
    )

    expected_label_key = spec.get("expectedLabelKey")
    expected_label = (
        source_row.expected_labels.get(str(expected_label_key))
        if expected_label_key
        else None
    )
    expected_label = _canonical_label(evaluator, expected_label)
    if spec.get("type") == "label":
        allowed = spec.get("labels")
        if label is None or (allowed and label not in allowed):
            invalid_reason = f"missing or unrecognized grader label: {label!r}"
        if expected_label is not None and allowed and expected_label not in allowed:
            invalid_reason = f"unrecognized reviewed label: {expected_label!r}"
        if raw_score is not None and (
            isinstance(raw_score, bool) or score is None or not math.isfinite(score) or not 0 <= score <= 1
        ):
            invalid_reason = f"invalid label grader score: {raw_score!r}"
    elif raw_score is not None:
        low, high = spec.get("range", [0, 5])
        if isinstance(raw_score, bool) or score is None or not math.isfinite(score) or not low <= score <= high:
            invalid_reason = f"invalid grader score: {raw_score!r}"
    elif spec.get("type") == "score":
        invalid_reason = "missing grader score"
    if invalid_reason:
        passed = None
    elif expected_label is not None:
        passed = label == expected_label
        if not passed and not reason:
            reason = f"label {label!r} does not match reviewed label {expected_label!r}"
    elif score is not None and spec.get("type") != "label":
        passed = score >= float(spec.get("scorePassThreshold", 3))
    elif label is not None:
        passed = label in {str(item) for item in spec.get("passingLabels", ())}

    if passed is None:
        return MetricObservation(
            row_id=source_row.row_id,
            case_id=source_row.case_id,
            family=source_row.family,
            variant=source_row.variant,
            source_category=source_row.source_category,
            sample_index=source_row.sample_index,
            evaluator=evaluator,
            passed=None,
            score=score if score is not None and math.isfinite(score) else None,
            label=label,
            reason=invalid_reason or reason or "Azure evaluator returned no usable result",
            infrastructure_error=True,
            details={"invalidOutput": True, "nativeRowId": source_row.row_id},
        )
    return MetricObservation(
        row_id=source_row.row_id,
        case_id=source_row.case_id,
        family=source_row.family,
        variant=source_row.variant,
        source_category=source_row.source_category,
        sample_index=source_row.sample_index,
        evaluator=evaluator,
        passed=passed,
        score=score,
        label=label,
        reason=reason,
        details={"expectedLabel": expected_label} if expected_label is not None else {},
    )


def _safe_name(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_.-]+", "-", value).strip("-")


def parse_native_result(
    result: Mapping[str, Any], spec: Mapping[str, Any], selected_rows: Sequence[NormalizedRow],
    diagnostics: Mapping[str, Any] | None = None,
) -> tuple[list[MetricObservation], set[str]]:
    evaluator = str(spec["name"])
    result_rows = result.get("rows")
    if not isinstance(result_rows, list):
        raise ValueError("native evaluator result has no rows array")
    source = {row.row_id: row for row in selected_rows}
    seen: set[str] = set()
    skipped: set[str] = set()
    observations = []
    for native in result_rows:
        if not isinstance(native, Mapping):
            raise ValueError("native evaluator row is not an object")
        row_id = native.get("inputs.row_id") or native.get("row_id")
        if row_id not in source or row_id in seen:
            raise ValueError(f"unknown or duplicate native row ID: {row_id!r}")
        seen.add(row_id)
        if _is_skipped_result(native, evaluator):
            skipped.add(row_id)
            # SDK skips are not proof of legitimate non-applicability.
            native = {}
        observations.append(observation_from_sdk_row(evaluator, spec, native, source[row_id]))
    for row_id in sorted(source.keys() - seen):
        observations.append(observation_from_sdk_row(evaluator, spec, {}, source[row_id]))
    if diagnostics:
        row_errors = diagnostics.get("rowErrors", {})
        observations = [
            replace(observation, reason=str(error),
                    details={**observation.details, "sdkEvaluatorError": True})
            if observation.passed is None and (
                error := row_errors.get(observation.row_id) or diagnostics.get("error")
            ) else observation
            for observation in observations
        ]
    return observations, skipped


def run_azure_evaluations(
    rows: Sequence[NormalizedRow],
    *,
    family_specs: Mapping[str, Sequence[Mapping[str, Any]]],
    runtime: AzureRuntime,
    output_dir: Path,
    evaluate_callable: EvaluateCallable | None = None,
    max_attempts: int = 3,
    base_delay_seconds: float = 1.0,
) -> list[EvaluatorRunOutcome]:
    if evaluate_callable is None:
        from azure.ai.evaluation import evaluate

        evaluate_callable = evaluate

    rows_by_family: dict[str, list[NormalizedRow]] = {}
    for row in rows:
        rows_by_family.setdefault(row.family, []).append(row)

    outcomes: list[EvaluatorRunOutcome] = []
    for family, specs in family_specs.items():
        family_rows = rows_by_family.get(family, [])
        for spec in specs:
            evaluator_name = str(spec["name"])
            selected_rows = applicable_rows(family_rows, spec)
            if not selected_rows:
                outcomes.append(
                    EvaluatorRunOutcome(
                        family=family,
                        evaluator=evaluator_name,
                        status="not-applicable",
                        artifact=None,
                    )
                )
                continue

            evaluator_dir = output_dir / _safe_name(family)
            input_path = evaluator_dir / f"{_safe_name(evaluator_name)}-input.jsonl"
            output_path = evaluator_dir / f"{_safe_name(evaluator_name)}.json"
            diagnostic_path = evaluator_dir / f"{_safe_name(evaluator_name)}-diagnostics.json"
            diagnostic_artifact = str(diagnostic_path.relative_to(output_dir.parent))
            write_jsonl(input_path, (sdk_row(row) for row in selected_rows))
            evaluator_config = {
                evaluator_name: {
                    "column_mapping": evaluator_column_mapping(spec)
                }
            }

            def operation() -> Mapping[str, Any]:
                assert evaluate_callable is not None
                return evaluate_callable(
                    data=input_path,
                    evaluators={evaluator_name: evaluator},
                    evaluation_name=f"scope-static-{family}-{evaluator_name}",
                    evaluator_config=evaluator_config,
                    azure_ai_project=runtime.project,
                    output_path=output_path,
                    fail_on_evaluator_errors=False,
                    tags={
                        "scope-evaluation": "static-prompts",
                        "family": family,
                    },
                )

            sdk_logger = logging.getLogger("azure.ai.evaluation._evaluate._evaluate")
            previous_level = sdk_logger.level
            diagnostics = _SdkDiagnostics(evaluator_name)
            sdk_logger.addHandler(diagnostics)
            sdk_logger.setLevel(logging.INFO)
            try:
                evaluator = create_evaluator(spec, runtime)
                for source_row in selected_rows:
                    try:
                        validate_sdk_input(evaluator, spec, source_row)
                    except Exception as error:
                        raise ValueError(f"SDK input validation failed for {source_row.row_id}: {error}") from error
                result, attempts = evaluate_with_retry(
                    operation,
                    max_attempts=max_attempts,
                    base_delay_seconds=base_delay_seconds,
                )
                if not output_path.exists():
                    write_json(output_path, dict(result))
                diagnostic_payload = diagnostics.payload(family, selected_rows, runtime.sdk_version)
                observations, skipped = parse_native_result(result, spec, selected_rows, diagnostic_payload)
                diagnostic_payload["invalidObservationCount"] = sum(o.passed is None for o in observations)
                write_json(diagnostic_path, diagnostic_payload)
                metrics = result.get("metrics")
                outcomes.append(
                    EvaluatorRunOutcome(
                        family=family,
                        evaluator=evaluator_name,
                        status=(
                            "not-applicable"
                            if skipped and not observations
                            else "infrastructure-failed"
                            if any(item.infrastructure_error for item in observations)
                            else "succeeded"
                        ),
                        artifact=str(output_path.relative_to(output_dir.parent)),
                        metrics=dict(metrics) if isinstance(metrics, Mapping) else {},
                        observations=tuple(observations),
                        attempts=attempts,
                        error=next((o.reason for o in observations if o.passed is None), None),
                        diagnostic_artifact=diagnostic_artifact,
                    )
                )
            except Exception as error:
                diagnostic_payload = diagnostics.payload(family, selected_rows, runtime.sdk_version)
                diagnostic_payload["error"] = redact_error(error)
                write_json(diagnostic_path, diagnostic_payload)
                outcomes.append(
                    EvaluatorRunOutcome(
                        family=family,
                        evaluator=evaluator_name,
                        status="infrastructure-failed",
                        artifact=(
                            str(output_path.relative_to(output_dir.parent))
                            if output_path.exists()
                            else None
                        ),
                        error=redact_error(error),
                        attempts=max_attempts if is_transient_error(error) else 1,
                        diagnostic_artifact=diagnostic_artifact,
                    )
                )
            finally:
                sdk_logger.removeHandler(diagnostics)
                sdk_logger.setLevel(previous_level)
    return outcomes
