"""Validated configuration and runtime models for cloud red teaming."""

from __future__ import annotations

from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class SurfaceId(StrEnum):
    TASK_SCENARIO_PROMPT = "task-scenario-prompt"
    GATE_PROMPT = "gate-prompt"
    AGENTS_MD = "agents-md"
    CRITERION_PROMPT = "criterion-prompt"
    PROMPT_FEATURE_DEFINITION = "prompt-feature-definition"
    PERSONA_INSTRUCTIONS = "persona-instructions"
    REPORT_USER_PROMPT = "report-user-prompt"
    REPORT_SYSTEM_PROMPT = "report-system-prompt"


class InsertionKind(StrEnum):
    USER_MESSAGE = "user-message"
    APPENDED_INSTRUCTION = "appended-instruction"
    OVERRIDING_SYSTEM_INSTRUCTION = "overriding-system-instruction"
    CRITERION = "criterion"
    FILESYSTEM_INSTRUCTION = "filesystem-instruction"
    DETECTOR_DEFINITION = "detector-definition"


class SurfaceProfile(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    id: SurfaceId
    adapter_id: str = Field(alias="adapterId", min_length=1)
    source_field: str = Field(alias="sourceField", min_length=1)
    downstream_consumer: str = Field(alias="downstreamConsumer", min_length=1)
    trusted_wrapper_source: str = Field(alias="trustedWrapperSource", min_length=1)
    insertion_point: str = Field(alias="insertionPoint", min_length=1)
    insertion_kind: InsertionKind = Field(alias="insertionKind")
    expected_boundary: str = Field(alias="expectedBoundary", min_length=1)
    prohibited_outcomes: list[str] = Field(
        alias="prohibitedOutcomes", min_length=1
    )
    supported_turns: set[Literal["single", "multi"]] = Field(
        alias="supportedTurns", min_length=1
    )
    canary: bool = False
    fixture: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def require_coding_agent_canary(self) -> SurfaceProfile:
        if self.id in {
            SurfaceId.TASK_SCENARIO_PROMPT,
            SurfaceId.GATE_PROMPT,
            SurfaceId.AGENTS_MD,
        } and not self.canary:
            raise ValueError("coding-agent surfaces must be labeled as canaries")
        return self


class SurfaceProfiles(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: int = Field(ge=1)
    profiles: list[SurfaceProfile] = Field(min_length=1)

    @model_validator(mode="after")
    def require_complete_unique_inventory(self) -> SurfaceProfiles:
        ids = [profile.id for profile in self.profiles]
        if len(ids) != len(set(ids)):
            raise ValueError("surface profile IDs must be unique")
        expected = set(SurfaceId)
        actual = set(ids)
        if actual != expected:
            missing = sorted(item.value for item in expected - actual)
            extra = sorted(str(item) for item in actual - expected)
            raise ValueError(
                f"surface inventory mismatch; missing={missing}, extra={extra}"
            )
        return self


class EvaluatorConfig(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    name: str = Field(min_length=1)
    evaluator_name: str = Field(alias="evaluatorName", min_length=1)
    version: str = Field(default="1", min_length=1)
    deployment_env: str | None = Field(default=None, alias="deploymentEnv")


class PollingConfig(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    interval_seconds: float = Field(alias="intervalSeconds", gt=0)
    timeout_seconds: float = Field(alias="timeoutSeconds", gt=0)
    max_transient_retries: int = Field(
        default=5, alias="maxTransientRetries", ge=0
    )
    base_retry_delay_seconds: float = Field(
        default=0.5, alias="baseRetryDelaySeconds", gt=0
    )
    max_retry_delay_seconds: float = Field(
        default=30.0, alias="maxRetryDelaySeconds", gt=0
    )


class RedTeamSettings(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    version: int = Field(ge=1)
    resource_prefix: str = Field(alias="resourcePrefix", min_length=3)
    project_endpoint_env: str = Field(alias="projectEndpointEnv", min_length=1)
    model_deployment_env: str = Field(
        alias="modelDeploymentEnv", min_length=1
    )
    keep_remote_env: str = Field(alias="keepRemoteEnv", min_length=1)
    attack_placeholder: str = Field(alias="attackPlaceholder", min_length=8)
    multi_turn_depth: int = Field(alias="multiTurnDepth", gt=0)
    attack_strategies: list[str] = Field(
        alias="attackStrategies", min_length=1
    )
    risk_categories: list[str] = Field(alias="riskCategories", min_length=1)
    evaluators: list[EvaluatorConfig] = Field(min_length=1)
    polling: PollingConfig
    adapter_command: list[str] = Field(alias="adapterCommand", min_length=1)

    @model_validator(mode="after")
    def require_approved_baseline_configuration(self) -> RedTeamSettings:
        required_strategies = {"Flip", "Base64", "IndirectJailbreak"}
        if not required_strategies.issubset(self.attack_strategies):
            raise ValueError(
                "attackStrategies must include Flip, Base64, and "
                "IndirectJailbreak"
            )
        required_evaluators = {
            "builtin.prohibited_actions",
            "builtin.task_adherence",
            "builtin.sensitive_data_leakage",
        }
        configured = {item.evaluator_name for item in self.evaluators}
        if not required_evaluators.issubset(configured):
            raise ValueError(
                "evaluators must include prohibited actions, task adherence, "
                "and sensitive data leakage"
            )
        task_adherence = next(
            item
            for item in self.evaluators
            if item.evaluator_name == "builtin.task_adherence"
        )
        if not task_adherence.deployment_env:
            raise ValueError(
                "builtin.task_adherence requires a deploymentEnv"
            )
        if self.polling.max_retry_delay_seconds < (
            self.polling.base_retry_delay_seconds
        ):
            raise ValueError(
                "maxRetryDelaySeconds cannot be below baseRetryDelaySeconds"
            )
        return self


class Message(BaseModel):
    model_config = ConfigDict(extra="allow")

    role: Literal["system", "developer", "user", "assistant", "tool"]
    content: Any


class PromptFile(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str
    content: str
    trust: Literal["trusted", "untrusted"]


class ComposedRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    adapter_id: str = Field(alias="adapterId")
    messages: list[Message] = Field(min_length=1)
    tools: list[dict[str, Any]] = Field(default_factory=list)
    files: list[PromptFile] = Field(default_factory=list)
    composition_fingerprint: str = Field(
        alias="compositionFingerprint", min_length=8
    )
    source_revision: str = Field(alias="sourceRevision", min_length=1)
