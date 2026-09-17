"""Reusable model-independent quality checks."""

from __future__ import annotations

import re
from collections import defaultdict
from collections.abc import Callable, Mapping, Sequence
from itertools import combinations
from typing import Any

from .data import as_string_list, first_path, stable_text
from .models import MetricObservation, NormalizedRow

_SNAKE_CASE = re.compile(r"^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$")
_URL = re.compile(r"https?://[^\s<>()\]\"']+")
_UUID = re.compile(
    r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"
)
_SOURCE_ID = re.compile(r"\b(?:insight|source|artifact|blob)[-_][A-Za-z0-9_-]+\b")
_WORD = re.compile(r"[a-z0-9]+")

Check = Callable[[NormalizedRow, Mapping[str, Any]], list[MetricObservation]]


def _observation(
    row: NormalizedRow,
    evaluator: str,
    passed: bool | None,
    *,
    score: float | None = None,
    reason: str = "",
    infrastructure_error: bool = False,
    details: Mapping[str, Any] | None = None,
) -> MetricObservation:
    return MetricObservation(
        row_id=row.row_id,
        case_id=row.case_id,
        family=row.family,
        variant=row.variant,
        source_category=row.source_category,
        sample_index=row.sample_index,
        evaluator=evaluator,
        passed=passed,
        score=score,
        reason=reason,
        infrastructure_error=infrastructure_error,
        details=dict(details or {}),
    )


def _paths(config: Mapping[str, Any], key: str = "paths") -> tuple[str, ...]:
    value = config.get(key, ())
    if isinstance(value, str):
        return (value,)
    if isinstance(value, Sequence):
        return tuple(str(item) for item in value)
    return ()


def _selected(row: NormalizedRow, paths: Sequence[str], default: Any = None) -> Any:
    return first_path(row.to_dict(), paths, default=default)


def _flatten_strings(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, Mapping):
        preferred = first_path(
            value,
            ("id", "criterionId", "criterion_id", "featureId", "feature_id", "name"),
        )
        if preferred is not None:
            return [str(preferred)]
        flattened: list[str] = []
        for child in value.values():
            flattened.extend(_flatten_strings(child))
        return flattened
    if isinstance(value, Sequence):
        flattened = []
        for child in value:
            flattened.extend(_flatten_strings(child))
        return flattened
    return [str(value)]


def check_generation_success(
    row: NormalizedRow, config: Mapping[str, Any]
) -> list[MetricObservation]:
    del config
    if row.generation_error is None:
        return [_observation(row, "generation_success", True, score=1.0)]
    return [
        _observation(
            row,
            "generation_success",
            None if row.infrastructure_error else False,
            score=None if row.infrastructure_error else 0.0,
            reason=row.generation_error,
            infrastructure_error=row.infrastructure_error,
        )
    ]


def check_output_schema(
    row: NormalizedRow, config: Mapping[str, Any]
) -> list[MetricObservation]:
    if row.generation_error:
        return [
            _observation(
                row,
                "output_schema",
                None if row.infrastructure_error else False,
                reason="generation did not produce a structured output",
                infrastructure_error=row.infrastructure_error,
            )
        ]
    required_any = _paths(config, "requiredAny")
    required_all = _paths(config, "requiredAll")
    row_dict = row.to_dict()
    allow_empty = bool(config.get("allowEmpty", False))

    def present(value: Any) -> bool:
        return value is not None if allow_empty else value not in (None, "", [], {})

    missing_all = [
        path
        for path in required_all
        if not present(first_path(row_dict, (path,)))
    ]
    any_present = not required_any or any(
        present(first_path(row_dict, (path,)))
        for path in required_any
    )
    passed = row.output is not None and not missing_all and any_present
    reason = ""
    if row.output is None:
        reason = "structured output is missing"
    elif missing_all:
        reason = f"required output fields are missing: {', '.join(missing_all)}"
    elif not any_present:
        reason = "none of the accepted output fields is present"
    return [_observation(row, "output_schema", passed, score=float(passed), reason=reason)]


def check_non_empty(
    row: NormalizedRow, config: Mapping[str, Any]
) -> list[MetricObservation]:
    value = _selected(row, _paths(config), default=row.response)
    passed = bool(stable_text(value).strip())
    return [
        _observation(
            row,
            str(config.get("metric") or "non_empty"),
            passed,
            score=float(passed),
            reason="" if passed else "required generated content is empty",
        )
    ]


def check_snake_case_identifier(
    row: NormalizedRow, config: Mapping[str, Any]
) -> list[MetricObservation]:
    value = _selected(row, _paths(config))
    identifiers = _flatten_strings(value)
    passed = bool(identifiers) and all(_SNAKE_CASE.fullmatch(item) for item in identifiers)
    return [
        _observation(
            row,
            str(config.get("metric") or "snake_case_identifier"),
            passed,
            score=float(passed),
            reason="" if passed else f"invalid snake-case identifier(s): {identifiers!r}",
            details={"identifiers": identifiers},
        )
    ]


def check_references_candidates(
    row: NormalizedRow, config: Mapping[str, Any]
) -> list[MetricObservation]:
    references = set(_flatten_strings(_selected(row, _paths(config, "referencePaths"))))
    candidates = set(_flatten_strings(_selected(row, _paths(config, "candidatePaths"))))
    invalid = sorted(references - candidates)
    passed = not invalid
    return [
        _observation(
            row,
            str(config.get("metric") or "candidate_references"),
            passed,
            score=float(passed),
            reason="" if passed else f"references outside candidate set: {invalid}",
            details={
                "references": sorted(references),
                "candidateCount": len(candidates),
            },
        )
    ]


def check_no_existing_duplicate(
    row: NormalizedRow, config: Mapping[str, Any]
) -> list[MetricObservation]:
    value = stable_text(_selected(row, _paths(config), default=row.response))
    existing = _flatten_strings(_selected(row, _paths(config, "existingPaths")))

    def canonical(text: str) -> str:
        return " ".join(text.casefold().split())

    duplicate = next(
        (candidate for candidate in existing if canonical(candidate) == canonical(value)),
        None,
    )
    passed = duplicate is None
    return [
        _observation(
            row,
            str(config.get("metric") or "no_existing_duplicate"),
            passed,
            score=float(passed),
            reason="" if passed else "generated text exactly duplicates an existing prompt",
        )
    ]


def check_forbidden_terms(
    row: NormalizedRow, config: Mapping[str, Any]
) -> list[MetricObservation]:
    text = stable_text(_selected(row, _paths(config), default=row.response))
    terms = [term.casefold() for term in as_string_list(config.get("terms"))]
    found = sorted(term for term in terms if re.search(rf"\b{re.escape(term)}\b", text.casefold()))
    passed = not found
    return [
        _observation(
            row,
            str(config.get("metric") or "forbidden_language"),
            passed,
            score=float(passed),
            reason="" if passed else f"forbidden process language found: {found}",
            details={"found": found},
        )
    ]


def check_no_questions(
    row: NormalizedRow, config: Mapping[str, Any]
) -> list[MetricObservation]:
    text = stable_text(_selected(row, _paths(config), default=row.response))
    passed = "?" not in text
    return [
        _observation(
            row,
            str(config.get("metric") or "no_questions"),
            passed,
            score=float(passed),
            reason="" if passed else "generated instruction contains a question",
        )
    ]


def check_markdown(
    row: NormalizedRow, config: Mapping[str, Any]
) -> list[MetricObservation]:
    text = stable_text(_selected(row, _paths(config), default=row.response))
    code_fences_balanced = text.count("```") % 2 == 0
    has_content = bool(text.strip())
    require_structure = bool(config.get("requireStructure", True))
    has_structure = bool(re.search(r"(?m)^(?:#{1,6}\s+|[-*]\s+|\d+\.\s+)", text))
    passed = has_content and code_fences_balanced and (
        has_structure or not require_structure
    )
    reasons = []
    if not has_content:
        reasons.append("report is empty")
    if not code_fences_balanced:
        reasons.append("Markdown code fences are unbalanced")
    if require_structure and not has_structure:
        reasons.append("report has no Markdown heading or list structure")
    return [
        _observation(
            row,
            str(config.get("metric") or "valid_markdown"),
            passed,
            score=float(passed),
            reason="; ".join(reasons),
        )
    ]


def check_no_fabricated_references(
    row: NormalizedRow, config: Mapping[str, Any]
) -> list[MetricObservation]:
    text = stable_text(_selected(row, _paths(config), default=row.response))
    allowed = "\n".join((row.context, row.ground_truth, stable_text(row.input)))
    discovered = set(_URL.findall(text)) | set(_UUID.findall(text)) | set(
        _SOURCE_ID.findall(text)
    )
    fabricated = sorted(reference for reference in discovered if reference not in allowed)
    passed = not fabricated
    return [
        _observation(
            row,
            str(config.get("metric") or "no_fabricated_references"),
            passed,
            score=float(passed),
            reason="" if passed else f"unverifiable source references: {fabricated}",
            details={"fabricated": fabricated},
        )
    ]


def check_label_metrics(
    row: NormalizedRow, config: Mapping[str, Any]
) -> list[MetricObservation]:
    predicted_value = _selected(row, _paths(config, "predictedPaths"))
    expected_value = _selected(row, _paths(config, "expectedPaths"))
    if config.get("detectedOnly"):
        reviewed_ids = set(_flatten_strings(expected_value))
        predicted = _detected_feature_ids(predicted_value) & reviewed_ids
        expected = _detected_feature_ids(expected_value)
    else:
        predicted = set(_flatten_strings(predicted_value))
        expected = set(_flatten_strings(expected_value))
    true_positive = len(predicted & expected)
    precision = true_positive / len(predicted) if predicted else float(not expected)
    recall = true_positive / len(expected) if expected else float(not predicted)
    f1 = (
        2 * precision * recall / (precision + recall)
        if precision + recall
        else 0.0
    )
    values = {
        "feature_precision": precision,
        "feature_recall": recall,
        "feature_f1": f1,
        "feature_exact_match": float(predicted == expected),
    }
    configured_thresholds = config.get("thresholds")
    thresholds = configured_thresholds if isinstance(configured_thresholds, Mapping) else {}
    observations = []
    for metric, score in values.items():
        threshold = float(thresholds.get(metric, 1.0))
        observations.append(
            _observation(
                row,
                metric,
                score >= threshold,
                score=score,
                reason=(
                    ""
                    if score >= threshold
                    else f"{metric} {score:.3f} is below {threshold:.3f}"
                ),
                details={
                    "predicted": sorted(predicted),
                    "expected": sorted(expected),
                },
            )
        )
    return observations


def _detected_feature_ids(value: Any) -> set[str]:
    if not isinstance(value, Sequence) or isinstance(value, str):
        return set()
    detected = set()
    for item in value:
        if not isinstance(item, Mapping) or item.get("detected") is not True:
            continue
        feature_id = first_path(item, ("featureId", "feature_id", "id"))
        if feature_id is not None:
            detected.add(str(feature_id))
    return detected


def check_feature_result_coverage(
    row: NormalizedRow, config: Mapping[str, Any]
) -> list[MetricObservation]:
    actual_value = _selected(row, _paths(config, "actualPaths"))
    expected_value = _selected(row, _paths(config, "expectedPaths"))
    actual_items = (
        list(actual_value)
        if isinstance(actual_value, Sequence) and not isinstance(actual_value, str)
        else []
    )
    actual_ids = [
        str(first_path(item, ("featureId", "feature_id", "id")))
        for item in actual_items
        if isinstance(item, Mapping)
        and first_path(item, ("featureId", "feature_id", "id")) is not None
    ]
    expected_ids = _flatten_strings(expected_value)
    malformed = [
        item
        for item in actual_items
        if not isinstance(item, Mapping)
        or not isinstance(item.get("detected"), bool)
        or not isinstance(item.get("evaluated"), bool)
    ]
    passed = (
        not malformed
        and len(actual_ids) == len(set(actual_ids))
        and set(actual_ids) == set(expected_ids)
    )
    return [
        _observation(
            row,
            str(config.get("metric") or "feature_result_coverage"),
            passed,
            score=float(passed),
            reason=(
                ""
                if passed
                else "feature extraction must return every supplied feature exactly once"
            ),
            details={
                "actual": actual_ids,
                "expected": expected_ids,
                "malformedCount": len(malformed),
            },
        )
    ]


def check_criterion_coverage(
    row: NormalizedRow, config: Mapping[str, Any]
) -> list[MetricObservation]:
    actual = set(_flatten_strings(_selected(row, _paths(config, "actualPaths"))))
    expected = set(_flatten_strings(_selected(row, _paths(config, "expectedPaths"))))
    missing = sorted(expected - actual)
    extra = sorted(actual - expected)
    passed = not missing and not extra
    return [
        _observation(
            row,
            str(config.get("metric") or "criterion_coverage"),
            passed,
            score=float(passed),
            reason="" if passed else f"criterion coverage mismatch; missing={missing}, extra={extra}",
            details={"actual": sorted(actual), "expected": sorted(expected)},
        )
    ]


def check_descendant_leakage(
    row: NormalizedRow, config: Mapping[str, Any]
) -> list[MetricObservation]:
    text = stable_text(_selected(row, _paths(config), default=row.response)).casefold()
    descendants = _flatten_strings(
        _selected(row, _paths(config, "descendantPaths"), default=[])
    )
    leaked = sorted(
        descendant
        for descendant in descendants
        if len(descendant.strip()) >= 8 and descendant.casefold() in text
    )
    passed = not leaked
    return [
        _observation(
            row,
            str(config.get("metric") or "descendant_leakage_check"),
            passed,
            score=float(passed),
            reason="" if passed else "feedback repeats descendant requirement text",
            details={"leaked": leaked},
        )
    ]


_CHECKS: dict[str, Check] = {
    "generation_success": check_generation_success,
    "output_schema": check_output_schema,
    "non_empty": check_non_empty,
    "snake_case_identifier": check_snake_case_identifier,
    "references_candidates": check_references_candidates,
    "no_existing_duplicate": check_no_existing_duplicate,
    "forbidden_terms": check_forbidden_terms,
    "no_questions": check_no_questions,
    "markdown": check_markdown,
    "no_fabricated_references": check_no_fabricated_references,
    "label_metrics": check_label_metrics,
    "feature_result_coverage": check_feature_result_coverage,
    "criterion_coverage": check_criterion_coverage,
    "descendant_leakage": check_descendant_leakage,
}


def _tokens(text: str) -> set[str]:
    return set(_WORD.findall(text.casefold()))


def _jaccard(left: str, right: str) -> float:
    left_tokens = _tokens(left)
    right_tokens = _tokens(right)
    if not left_tokens and not right_tokens:
        return 1.0
    union = left_tokens | right_tokens
    return len(left_tokens & right_tokens) / len(union) if union else 1.0


def evaluate_sample_diversity(
    rows: Sequence[NormalizedRow],
    config: Mapping[str, Any],
) -> list[MetricObservation]:
    by_case: dict[str, list[NormalizedRow]] = defaultdict(list)
    for row in rows:
        by_case[row.case_id].append(row)
    observations: list[MetricObservation] = []
    for case_rows in by_case.values():
        ordered = sorted(case_rows, key=lambda row: row.sample_index)
        responses = [row.response.strip() for row in ordered if row.response.strip()]
        unique_ratio = len(set(responses)) / len(responses) if responses else 0.0
        similarities = [_jaccard(left, right) for left, right in combinations(responses, 2)]
        max_similarity = max(similarities, default=0.0)
        min_unique_ratio = float(config.get("minUniqueRatio", 0.67))
        max_pair_similarity = float(config.get("maxPairSimilarity", 0.95))
        passed = (
            unique_ratio >= min_unique_ratio and max_similarity <= max_pair_similarity
        )
        representative = ordered[0]
        observations.append(
            _observation(
                representative,
                str(config.get("metric") or "sample_diversity"),
                passed,
                score=unique_ratio,
                reason=(
                    ""
                    if passed
                    else (
                        f"unique ratio {unique_ratio:.3f}, maximum pair similarity "
                        f"{max_similarity:.3f}"
                    )
                ),
                details={
                    "uniqueRatio": unique_ratio,
                    "maxPairSimilarity": max_similarity,
                    "sampleCount": len(ordered),
                },
            )
        )
    return observations


def evaluate_deterministic(
    rows: Sequence[NormalizedRow],
    family_configs: Mapping[str, Mapping[str, Any]],
) -> list[MetricObservation]:
    observations: list[MetricObservation] = []
    rows_by_family: dict[str, list[NormalizedRow]] = defaultdict(list)
    for row in rows:
        rows_by_family[row.family].append(row)

    for family, family_rows in rows_by_family.items():
        family_config = family_configs.get(family)
        if family_config is None:
            raise ValueError(f"missing quality configuration for family {family!r}")
        checks = family_config.get("deterministic", ())
        if not isinstance(checks, Sequence):
            raise ValueError(f"deterministic checks for {family!r} must be a list")
        for raw_config in checks:
            if not isinstance(raw_config, Mapping):
                raise ValueError(f"invalid deterministic check for {family!r}")
            check_name = str(raw_config.get("check") or "")
            if check_name == "sample_diversity":
                observations.extend(evaluate_sample_diversity(family_rows, raw_config))
                continue
            check = _CHECKS.get(check_name)
            if check is None:
                raise ValueError(
                    f"unknown deterministic check {check_name!r} for {family!r}"
                )
            for row in family_rows:
                observations.extend(check(row, raw_config))
    return observations
