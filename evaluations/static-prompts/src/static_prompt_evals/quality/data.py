"""JSONL loading and normalization for generated prompt outputs."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any

from .models import NormalizedRow

_INFRASTRUCTURE_CLASSIFICATIONS = {
    "authentication",
    "authorization",
    "infrastructure",
    "network",
    "rate_limit",
    "timeout",
    "transport",
}


class QualityDataError(ValueError):
    """Raised when quality input data violates the runner contract."""


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, start=1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise QualityDataError(
                    f"{path}:{line_number}: invalid JSON: {error.msg}"
                ) from error
            if not isinstance(value, dict):
                raise QualityDataError(
                    f"{path}:{line_number}: each JSONL value must be an object"
                )
            rows.append(value)
    if not rows:
        raise QualityDataError(f"{path}: dataset is empty")
    return rows


def read_quality_cases(path: Path) -> list[dict[str, Any]]:
    """Read an explicit JSONL file or the files declared by dataset manifest."""

    if path.is_file():
        if path.name == "manifest.json":
            return _read_manifest_cases(path)
        return read_jsonl(path)
    dataset_root = path if path.is_dir() else path.parent
    if dataset_root.name == "v1":
        dataset_root = dataset_root.parent
    manifest_path = dataset_root / "manifest.json"
    if not manifest_path.is_file():
        raise QualityDataError(
            f"quality dataset manifest not found: {manifest_path}"
        )
    return _read_manifest_cases(manifest_path)


def _read_manifest_cases(manifest_path: Path) -> list[dict[str, Any]]:
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except OSError as error:
        raise QualityDataError(f"cannot read {manifest_path}: {error}") from error
    except json.JSONDecodeError as error:
        raise QualityDataError(
            f"{manifest_path}: invalid JSON: {error.msg}"
        ) from error
    if not isinstance(manifest, Mapping):
        raise QualityDataError(f"{manifest_path}: manifest must be an object")
    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        raise QualityDataError(f"{manifest_path}: manifest.files must be a list")

    rows: list[dict[str, Any]] = []
    for index, entry in enumerate(files):
        if not isinstance(entry, Mapping) or not isinstance(entry.get("path"), str):
            raise QualityDataError(
                f"{manifest_path}: manifest.files[{index}] requires path"
            )
        file_path = (manifest_path.parent / entry["path"]).resolve()
        try:
            file_path.relative_to(manifest_path.parent.resolve())
        except ValueError as error:
            raise QualityDataError(
                f"{manifest_path}: dataset path escapes manifest directory"
            ) from error
        if file_path.suffix != ".jsonl":
            continue
        try:
            contents = file_path.read_bytes()
        except OSError as error:
            raise QualityDataError(f"cannot read {file_path}: {error}") from error
        expected_hash = entry.get("sha256")
        actual_hash = hashlib.sha256(contents).hexdigest()
        if expected_hash is not None and expected_hash != actual_hash:
            raise QualityDataError(
                f"{file_path}: SHA-256 does not match datasets manifest"
            )
        file_rows = read_jsonl(file_path)
        expected_rows = entry.get("rows")
        if expected_rows is not None and expected_rows != len(file_rows):
            raise QualityDataError(
                f"{file_path}: expected {expected_rows} rows, found {len(file_rows)}"
            )
        rows.extend(file_rows)
    if not rows:
        raise QualityDataError(f"{manifest_path}: no JSONL quality cases declared")
    return rows


def write_jsonl(path: Path, rows: Iterable[Mapping[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as stream:
        for row in rows:
            stream.write(json.dumps(dict(row), sort_keys=True, ensure_ascii=False))
            stream.write("\n")


def get_path(value: Any, path: str, default: Any = None) -> Any:
    current = value
    for part in path.split("."):
        if isinstance(current, Mapping) and part in current:
            current = current[part]
        else:
            return default
    return current


def first_path(value: Any, paths: Sequence[str], default: Any = None) -> Any:
    for path in paths:
        found = get_path(value, path, default=None)
        if found is not None:
            return found
    return default


def as_mapping(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def as_object_list(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [dict(item) for item in value if isinstance(item, Mapping)]


def as_string_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if not isinstance(value, Sequence):
        return []
    return [str(item) for item in value if item is not None]


def stable_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def sdk_messages(messages: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Map retained text/tool messages to the pinned SDK's content-block schema."""
    result = []
    for message in messages:
        item = dict(message)
        content = item.get("content")
        if isinstance(content, str):
            item["content"] = content if item.get("role") == "system" else [
                {"type": "tool_result", "tool_result": content}
                if item.get("role") == "tool" else {"type": "text", "text": content}
            ]
        elif not isinstance(content, list):
            raise QualityDataError("conversation content must be text or content blocks")
        else:
            item["content"] = [
                sdk_tool_call(block.get("tool_call", block))
                if isinstance(block, Mapping) and block.get("type") == "tool_call" else block
                for block in content
            ]
        result.append(item)
    return result


def sdk_tool_call(call: Mapping[str, Any]) -> dict[str, Any]:
    function = dict(call.get("function") or {"name": call.get("name"), "arguments": call.get("arguments", {})})
    if isinstance(function.get("arguments"), str):
        function["arguments"] = json.loads(function["arguments"])
    call_id = call.get("tool_call_id") or call.get("id")
    if not isinstance(call_id, str) or not call_id or not isinstance(function.get("name"), str) or not function["name"] or not isinstance(function.get("arguments"), dict):
        raise QualityDataError("retained tool call lacks an id, name, or structured arguments")
    return {"type": "tool_call", "tool_call_id": call_id,
            "name": function["name"], "arguments": function["arguments"]}


def tool_response_messages(calls: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    messages = []
    for call in calls:
        normalized_call = sdk_tool_call(call)
        messages.append({"role": "assistant", "content": [normalized_call]})
        if "response" in call:
            messages.append({"role": "tool", "tool_call_id": normalized_call["tool_call_id"], "content": [
                {"type": "tool_result", "tool_result": stable_text(call["response"])}
            ]})
    return messages


def render_response(family: str, output: Any, raw_response: str) -> str:
    if isinstance(output, str) and output.strip():
        return output.strip()
    preferred_paths = {
        "criteria-authoring": ("prompt", "criterion.prompt", "criteria"),
        "parent-dependency-suggestion": ("suggestions", "dependencies", "parents"),
        "child-dependency-suggestion": ("suggestions", "dependencies", "children"),
        "task-prompt-generation": ("prompt", "taskPrompt"),
        "task-prompt-variation": ("prompt", "taskPrompt", "variation"),
        "prompt-feature-authoring": ("prompt", "description", "definition", "feature"),
        "prompt-feature-extraction": (
            "results",
            "features",
            "featureIds",
            "selectedFeatureIds",
            "suggestedFeatures",
        ),
        "judge-instructions": ("results", "verdicts", "evaluation"),
        "developer-feedback": ("feedback", "text", "message"),
        "run-report": ("markdown", "report", "content"),
    }
    for path in preferred_paths.get(family, ()):
        candidate = get_path(output, path)
        if candidate not in (None, "", [], {}):
            return stable_text(candidate)
    if output not in (None, "", [], {}):
        return stable_text(output)
    return raw_response.strip()


def _case_id(row: Mapping[str, Any]) -> str:
    value = first_path(row, ("id", "caseId", "case_id"))
    if not isinstance(value, str) or not value.strip():
        raise QualityDataError("every quality case requires a non-empty id")
    return value.strip()


def _sample_index(row: Mapping[str, Any]) -> int:
    value = first_path(row, ("sampleIndex", "sample_index"), default=0)
    try:
        index = int(value)
    except (TypeError, ValueError) as error:
        raise QualityDataError(f"invalid sample index {value!r}") from error
    if index < 0:
        raise QualityDataError("sample index must be non-negative")
    return index


def _generation_error(row: Mapping[str, Any]) -> tuple[str | None, bool]:
    error = first_path(row, ("error", "generationError", "generation_error"))
    classification = str(
        first_path(
            row,
            ("errorClassification", "error_classification", "error.classification"),
            default="",
        )
    ).lower()
    if error in (None, "", {}):
        return None, False
    if isinstance(error, Mapping):
        message = str(error.get("message") or error.get("type") or "generation failed")
    else:
        message = str(error)
    return message, classification in _INFRASTRUCTURE_CLASSIFICATIONS


def _expected_labels(
    case: Mapping[str, Any], expected: Mapping[str, Any]
) -> dict[str, Any]:
    labels = as_mapping(
        first_path(
            case,
            ("expectedLabels", "expected_labels", "expected.labels"),
            default={},
        )
    )
    if expected.get("evidenceSource") is not None:
        labels.setdefault(
            "criteria_evidence_source", expected["evidenceSource"]
        )
    return labels


def normalize_rows(
    cases: Sequence[Mapping[str, Any]],
    generated_rows: Sequence[Mapping[str, Any]],
    *,
    expected_samples: int,
) -> list[NormalizedRow]:
    if expected_samples < 1:
        raise QualityDataError("expected_samples must be at least one")

    case_by_id: dict[str, Mapping[str, Any]] = {}
    for case in cases:
        case_id = _case_id(case)
        if case_id in case_by_id:
            raise QualityDataError(f"duplicate quality case id: {case_id}")
        family = case.get("family")
        if not isinstance(family, str) or not family:
            raise QualityDataError(f"quality case {case_id} requires a family")
        case_by_id[case_id] = case

    generated_by_key: dict[tuple[str, int], Mapping[str, Any]] = {}
    for generated in generated_rows:
        case_id = _case_id(generated)
        if case_id not in case_by_id:
            raise QualityDataError(
                f"generated output references unknown quality case: {case_id}"
            )
        key = (case_id, _sample_index(generated))
        if key[1] >= expected_samples:
            raise QualityDataError(f"unexpected sample index for {case_id}: {key[1]}")
        if key in generated_by_key:
            raise QualityDataError(
                f"duplicate generated output for {case_id} sample {key[1]}"
            )
        generated_by_key[key] = generated

    normalized: list[NormalizedRow] = []
    for case_id, case in case_by_id.items():
        for sample_index in range(expected_samples):
            generated = generated_by_key.get((case_id, sample_index))
            missing = generated is None
            generated = generated or {}
            family = str(case["family"])
            variant = str(case.get("variant") or "default")
            if generated.get("family") not in (None, family):
                raise QualityDataError(
                    f"generated output family mismatch for {case_id}: "
                    f"{generated.get('family')!r} != {family!r}"
                )
            if generated.get("variant") not in (None, variant):
                raise QualityDataError(
                    f"generated output variant mismatch for {case_id}: "
                    f"{generated.get('variant')!r} != {variant!r}"
                )

            case_input = as_mapping(case.get("input"))
            expected = as_mapping(case.get("expected"))
            output = first_path(
                generated,
                ("output", "structuredOutput", "structured_output", "result"),
            )
            raw_response = str(
                first_path(generated, ("rawResponse", "raw_response"), default="") or ""
            )
            generation_error, infrastructure_error = _generation_error(generated)
            if missing:
                generation_error = "adapter did not emit the expected generated row"
                infrastructure_error = True

            expected_behavior = stable_text(
                first_path(
                    case,
                    (
                        "expected_behavior",
                        "expectedBehavior",
                        "expected.behavior",
                        "expected.description",
                        "input.behavior",
                        "input.description",
                        "input.userPrompt",
                        "input.taskText",
                        "input.request",
                    ),
                    default="",
                )
            )
            query = stable_text(
                first_path(
                    case,
                    (
                        "query",
                        "input.query",
                        "input.request",
                        "input.behavior",
                        "input.description",
                        "input.prompt",
                    ),
                    default=expected_behavior or case_input,
                )
            )
            context = stable_text(
                first_path(
                    case,
                    (
                        "evidence_context",
                        "evidenceContext",
                        "input.evidenceContext",
                        "input.context",
                        "context",
                    ),
                    default=case_input,
                )
            )
            ground_truth = stable_text(
                first_path(
                    case,
                    (
                        "ground_truth",
                        "groundTruth",
                        "expected.groundTruth",
                        "expected.reference",
                    ),
                    default=expected,
                )
            )
            query_messages = as_object_list(
                first_path(
                    generated,
                    ("queryMessages", "query_messages", "request.messages"),
                    default=first_path(
                        case,
                        ("queryMessages", "query_messages", "input.messages"),
                    ),
                )
            )
            response_messages = as_object_list(
                first_path(
                    generated,
                    ("responseMessages", "response_messages", "messages"),
                )
            )
            response = render_response(family, output, raw_response)
            if family in {"parent-dependency-suggestion", "child-dependency-suggestion", "developer-feedback"}:
                # Production-composed instructions define the task; reviewed answers
                # remain exclusively in ground_truth, not in the evaluator query.
                query = stable_text(query_messages) if query_messages else stable_text(case_input)
            if family == "developer-feedback" and query_messages:
                context = stable_text(query_messages)
            if not query_messages:
                query_messages = [{"role": "user", "content": query}]
            if not response_messages:
                response_messages = [{"role": "assistant", "content": raw_response or response}]

            expected_labels = _expected_labels(case, expected)
            tool_definitions = as_object_list(
                first_path(
                    generated,
                    ("toolDefinitions", "tool_definitions", "request.tools"),
                    default=first_path(
                        case,
                        ("toolDefinitions", "tool_definitions", "input.toolDefinitions"),
                    ),
                )
            )
            tool_calls = as_object_list(
                first_path(
                    generated,
                    (
                        "toolCalls",
                        "tool_calls",
                        "invocationMetadata.toolCalls",
                        "invocation_metadata.tool_calls",
                    ),
                    default=[],
                )
            )
            if tool_calls and not any(m.get("role") == "tool" for m in response_messages):
                response_messages = [*tool_response_messages(tool_calls), *response_messages]
            query_messages = sdk_messages(query_messages)
            response_messages = sdk_messages(response_messages)
            tool_calls = [sdk_tool_call(call) for call in tool_calls]
            source_category = str(
                first_path(
                    case,
                    (
                        "sourceCategory",
                        "source_category",
                        "provenance.category",
                        "provenance.kind",
                    ),
                    default="unspecified",
                )
            )
            normalized.append(
                NormalizedRow(
                    row_id=f"{case_id}::sample-{sample_index}",
                    case_id=case_id,
                    family=family,
                    variant=variant,
                    sample_index=sample_index,
                    source_category=source_category,
                    query=query,
                    response=response,
                    context=context,
                    ground_truth=ground_truth,
                    expected_behavior=expected_behavior,
                    input=case_input,
                    expected=expected,
                    expected_labels=expected_labels,
                    output=output,
                    raw_response=raw_response,
                    query_messages=query_messages,
                    response_messages=response_messages,
                    tool_definitions=tool_definitions,
                    tool_calls=tool_calls,
                    generation_error=generation_error,
                    infrastructure_error=infrastructure_error,
                    metadata=as_mapping(
                        first_path(
                            generated,
                            ("metadata", "invocationMetadata", "invocation_metadata"),
                            default={},
                        )
                    ),
                )
            )
    return normalized
