"""Native result persistence and per-surface red-team aggregation."""

from __future__ import annotations

import csv
import io
import json
from dataclasses import asdict, dataclass, is_dataclass
from datetime import date, datetime
from enum import Enum
from pathlib import Path
from typing import Any, Iterable, Mapping


@dataclass(frozen=True)
class NativeResult:
    content: bytes
    media_type: str


_MEDIA_EXTENSIONS = {
    "application/json": ".json",
    "application/jsonl": ".jsonl",
    "application/x-jsonlines": ".jsonl",
    "application/x-ndjson": ".jsonl",
    "text/csv": ".csv",
}


def to_primitive(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, Mapping):
        return {str(key): to_primitive(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [to_primitive(item) for item in value]
    if hasattr(value, "model_dump"):
        return to_primitive(value.model_dump(mode="json"))
    if hasattr(value, "as_dict"):
        return to_primitive(value.as_dict())
    if is_dataclass(value):
        return to_primitive(asdict(value))
    raise TypeError(f"cannot serialize {type(value).__name__}")


def native_json(items: Iterable[Any]) -> NativeResult:
    body = json.dumps(
        [to_primitive(item) for item in items],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return NativeResult(content=body.encode("utf-8"), media_type="application/json")


def persist_native_result(
    directory: Path,
    stem: str,
    result: NativeResult,
) -> Path:
    media_type = result.media_type.split(";", 1)[0].strip().lower()
    try:
        extension = _MEDIA_EXTENSIONS[media_type]
    except KeyError as error:
        raise ValueError(
            f"unsupported native result media type: {result.media_type}"
        ) from error
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{stem}{extension}"
    path.write_bytes(result.content)
    return path


def parse_native_result(result: NativeResult) -> list[dict[str, Any]]:
    media_type = result.media_type.split(";", 1)[0].strip().lower()
    text = result.content.decode("utf-8")
    if media_type == "application/json":
        value = json.loads(text)
        if isinstance(value, dict):
            for key in ("data", "items", "output_items"):
                nested = value.get(key)
                if isinstance(nested, list):
                    value = nested
                    break
        if not isinstance(value, list):
            raise ValueError("JSON red-team output must contain a list")
        return [dict(item) for item in value]
    if media_type in {"application/jsonl", "application/x-jsonlines", "application/x-ndjson"}:
        return [
            dict(json.loads(line))
            for line in text.splitlines()
            if line.strip()
        ]
    if media_type == "text/csv":
        return [dict(row) for row in csv.DictReader(io.StringIO(text))]
    raise ValueError(
        f"unsupported native result media type: {result.media_type}"
    )


def _result_entries(item: Mapping[str, Any]) -> list[dict[str, Any]]:
    values = item.get("results", [])
    return [dict(value) for value in values if isinstance(value, Mapping)]


def _attack_strategy(item: Mapping[str, Any]) -> str | None:
    source = item.get("datasource_item", item.get("datasourceItem", {}))
    if not isinstance(source, Mapping):
        return None
    for key in ("attack_strategy", "attackStrategy", "strategy"):
        value = source.get(key)
        if value:
            return str(value)
    metadata = source.get("metadata")
    if isinstance(metadata, Mapping):
        for key in ("attack_strategy", "attackStrategy", "strategy"):
            value = metadata.get(key)
            if value:
                return str(value)
    return None


def aggregate_surface(
    surface_id: str,
    items: Iterable[Mapping[str, Any]],
) -> dict[str, Any]:
    rows = [dict(item) for item in items]
    evaluator_counts: dict[str, dict[str, int]] = {}
    findings: list[dict[str, Any]] = []
    successful_attacks = 0
    completed_items = 0
    errored_items = 0

    for item in rows:
        entries = _result_entries(item)
        if (
            str(item.get("status", "")).casefold() in {"error", "errored", "failed"}
            or not entries
        ):
            errored_items += 1
            continue
        item_failed = False
        item_complete = True
        for result in entries:
            evaluator = str(result.get("name", "unknown"))
            counts = evaluator_counts.setdefault(
                evaluator, {"passed": 0, "failed": 0, "errored": 0}
            )
            passed = result.get("passed")
            if not isinstance(passed, bool):
                counts["errored"] += 1
                item_complete = False
                continue
            failed = not passed
            counts["failed" if failed else "passed"] += 1
            if failed:
                item_failed = True
                findings.append(
                    {
                        "surfaceId": surface_id,
                        "outputItemId": item.get("id"),
                        "attackStrategy": _attack_strategy(item),
                        "evaluator": evaluator,
                        "score": result.get("score"),
                        "evidence": result.get("sample", item.get("sample")),
                    }
                )
        if item_complete:
            completed_items += 1
            successful_attacks += int(item_failed)
        else:
            errored_items += 1

    evaluator_summaries: dict[str, dict[str, Any]] = {}
    for evaluator, counts in sorted(evaluator_counts.items()):
        total = counts["passed"] + counts["failed"]
        evaluator_summaries[evaluator] = {
            **counts,
            "attackSuccessRate": counts["failed"] / total if total else 0.0,
        }

    total_items = len(rows)
    return {
        "surfaceId": surface_id,
        "totalItems": total_items,
        "completedItems": completed_items,
        "erroredItems": errored_items,
        "successfulAttacks": successful_attacks,
        "attackSuccessRate": (
            successful_attacks / completed_items if completed_items else 0.0
        ),
        "evaluators": evaluator_summaries,
        "findings": findings,
    }
