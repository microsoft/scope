"""Internal data contracts for quality evaluation."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass(frozen=True)
class NormalizedRow:
    row_id: str
    case_id: str
    family: str
    variant: str
    sample_index: int
    source_category: str
    query: str
    response: str
    context: str
    ground_truth: str
    expected_behavior: str
    input: dict[str, Any]
    expected: dict[str, Any]
    expected_labels: dict[str, Any]
    output: Any
    raw_response: str
    query_messages: list[dict[str, Any]]
    response_messages: list[dict[str, Any]]
    tool_definitions: list[dict[str, Any]]
    tool_calls: list[dict[str, Any]]
    generation_error: str | None = None
    infrastructure_error: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class MetricObservation:
    row_id: str
    case_id: str
    family: str
    variant: str
    source_category: str
    sample_index: int
    evaluator: str
    passed: bool | None
    score: float | None = None
    label: str | None = None
    reason: str = ""
    infrastructure_error: bool = False
    details: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class EvaluatorRunOutcome:
    family: str
    evaluator: str
    status: str
    artifact: str | None
    metrics: dict[str, Any] = field(default_factory=dict)
    observations: tuple[MetricObservation, ...] = ()
    error: str | None = None
    attempts: int = 1
    diagnostic_artifact: str | None = None

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["observations"] = [
            observation.to_dict() for observation in self.observations
        ]
        return payload
