"""Narrow Azure AI Projects client for cloud red-team lifecycle operations."""

from __future__ import annotations

import asyncio
import os
import random
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Mapping, Protocol, TypeVar

from azure.ai.projects import AIProjectClient
from azure.ai.projects.models import (
    AgentTaxonomyInput,
    AzureAIAgentTarget,
    AzureAIModelTarget,
    EvaluationTaxonomy,
    FunctionTool,
    PromptAgentDefinition,
    RiskCategory,
)
from azure.core.exceptions import (
    HttpResponseError,
    ServiceRequestError,
    ServiceResponseError,
)
from azure.identity import DefaultAzureCredential
from openai import APIConnectionError, APIStatusError, APITimeoutError

from .models import EvaluatorConfig, PollingConfig, RedTeamSettings
from .results import NativeResult, native_json, to_primitive

T = TypeVar("T")


@dataclass(frozen=True)
class TemporaryTarget:
    name: str
    version: str
    identity: str
    tool_descriptions: tuple[dict[str, str], ...] = ()
    kind: str = "azure_ai_agent"
    temporary: bool = True

    def as_run_target(self) -> dict[str, Any]:
        if self.kind == "azure_ai_model":
            return {"type": "azure_ai_model", "model": self.name}
        value: dict[str, Any] = {
            "type": self.kind,
            "name": self.name,
            "version": self.version,
        }
        if self.tool_descriptions:
            value["tool_descriptions"] = list(self.tool_descriptions)
        return value


@dataclass(frozen=True)
class TaxonomyResource:
    name: str
    id: str
    value: dict[str, Any]


@dataclass(frozen=True)
class RemoteRun:
    id: str
    status: str
    value: dict[str, Any]


@dataclass(frozen=True)
class OutputDownload:
    items: list[dict[str, Any]]
    native: NativeResult


class CloudRedTeamClient(Protocol):
    async def create_evaluation(
        self, name: str, evaluators: list[EvaluatorConfig]
    ) -> str: ...

    async def create_target(
        self,
        name: str,
        deployment: str,
        instructions: str,
        tools: list[dict[str, object]],
        metadata: dict[str, str],
    ) -> TemporaryTarget: ...

    async def create_taxonomy(
        self,
        name: str,
        target: TemporaryTarget,
        risk_categories: list[str],
    ) -> TaxonomyResource: ...

    async def create_run(
        self,
        evaluation_id: str,
        name: str,
        target: TemporaryTarget,
        taxonomy_id: str,
        attack_strategies: list[str],
        multi_turn_depth: int,
        metadata: dict[str, str],
    ) -> RemoteRun: ...

    async def get_run(
        self, evaluation_id: str, run_id: str
    ) -> RemoteRun: ...

    async def download_output(
        self, evaluation_id: str, run_id: str
    ) -> OutputDownload: ...

    async def delete_run(self, evaluation_id: str, run_id: str) -> None: ...

    async def delete_evaluation(self, evaluation_id: str) -> None: ...

    async def delete_taxonomy(self, name: str) -> None: ...

    async def delete_target(self, target: TemporaryTarget) -> None: ...

    async def close(self) -> None: ...


class AzureCloudRedTeamClient:
    """SDK adapter limited to resources required by cloud red teaming."""

    def __init__(
        self,
        project_client: AIProjectClient,
        polling: PollingConfig,
        *,
        credential: DefaultAzureCredential | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._project = project_client
        self._openai = project_client.get_openai_client(max_retries=0)
        self._polling = polling
        self._credential = credential
        self._sleep = sleep

    @classmethod
    def from_environment(
        cls,
        settings: RedTeamSettings,
    ) -> AzureCloudRedTeamClient:
        endpoint = os.environ.get(settings.project_endpoint_env)
        if not endpoint:
            raise ValueError(
                f"{settings.project_endpoint_env} is required for red teaming"
            )
        credential = DefaultAzureCredential()
        project = AIProjectClient(
            endpoint=endpoint,
            credential=credential,
            allow_preview=True,
            retry_total=0,
        )
        return cls(project, settings.polling, credential=credential)

    async def create_evaluation(
        self,
        name: str,
        evaluators: list[EvaluatorConfig],
    ) -> str:
        criteria: list[dict[str, Any]] = []
        for evaluator in evaluators:
            criterion: dict[str, Any] = {
                "type": "azure_ai_evaluator",
                "name": evaluator.name,
                "evaluator_name": evaluator.evaluator_name,
                "evaluator_version": evaluator.version,
            }
            if evaluator.deployment_env:
                deployment = os.environ.get(evaluator.deployment_env)
                if not deployment:
                    raise ValueError(
                        f"{evaluator.deployment_env} is required by "
                        f"{evaluator.evaluator_name}"
                    )
                criterion["initialization_parameters"] = {
                    "deployment_name": deployment
                }
            criteria.append(criterion)
        result = await asyncio.to_thread(
            self._openai.evals.create,
            name=name,
            data_source_config={
                "type": "azure_ai_source",
                "scenario": "red_team",
            },
            testing_criteria=criteria,
        )
        return str(result.id)

    async def create_target(
        self,
        name: str,
        deployment: str,
        instructions: str,
        tools: list[dict[str, object]],
        metadata: dict[str, str],
    ) -> TemporaryTarget:
        function_tools = [
            FunctionTool(
                name=str(tool.get("name", "unknown")),
                description=str(tool.get("description", "")),
                parameters=(
                    dict(tool["parameters"])
                    if isinstance(tool.get("parameters"), Mapping)
                    else {"type": "object", "properties": {}}
                ),
                strict=False,
            )
            for tool in tools
        ]
        definition = PromptAgentDefinition(
            model=deployment,
            instructions=instructions,
            tools=function_tools or None,
        )
        result = await asyncio.to_thread(
            self._project.agents.create_version,
            agent_name=name,
            definition=definition,
            metadata=metadata,
            description="Temporary Scope static-prompt red-team target",
        )
        return TemporaryTarget(
            name=str(result.name),
            version=str(result.version),
            identity=str(result.id),
            tool_descriptions=tuple(
                {
                    "name": str(tool.get("name", "unknown")),
                    "description": str(tool.get("description", "")),
                }
                for tool in tools
            ),
        )

    async def create_taxonomy(
        self,
        name: str,
        target: TemporaryTarget,
        risk_categories: list[str],
    ) -> TaxonomyResource:
        taxonomy = EvaluationTaxonomy(
            name=name,
            version="1",
            description="Scope static-prompt prohibited-action taxonomy",
            taxonomy_input=AgentTaxonomyInput(
                target=(
                    AzureAIModelTarget(model=target.name)
                    if target.kind == "azure_ai_model"
                    else AzureAIAgentTarget(
                        name=target.name,
                        version=target.version,
                    )
                ),
                risk_categories=[
                    _risk_category(value) for value in risk_categories
                ],
            ),
        )
        result = await asyncio.to_thread(
            self._project.beta.evaluation_taxonomies.create,
            name=name,
            taxonomy=taxonomy,
        )
        return TaxonomyResource(
            name=name,
            id=str(result.id),
            value=dict(to_primitive(result)),
        )

    async def create_run(
        self,
        evaluation_id: str,
        name: str,
        target: TemporaryTarget,
        taxonomy_id: str,
        attack_strategies: list[str],
        multi_turn_depth: int,
        metadata: dict[str, str],
    ) -> RemoteRun:
        result = await asyncio.to_thread(
            self._openai.evals.runs.create,
            eval_id=evaluation_id,
            name=name,
            metadata=metadata,
            data_source={
                "type": "azure_ai_red_team",
                "item_generation_params": {
                    "type": "red_team_taxonomy",
                    "attack_strategies": attack_strategies,
                    "num_turns": multi_turn_depth,
                    "source": {"type": "file_id", "id": taxonomy_id},
                },
                "target": target.as_run_target(),
            },
        )
        return _remote_run(result)

    async def get_run(
        self,
        evaluation_id: str,
        run_id: str,
    ) -> RemoteRun:
        result = await self._retry(
            lambda: asyncio.to_thread(
                self._openai.evals.runs.retrieve,
                run_id=run_id,
                eval_id=evaluation_id,
            )
        )
        return _remote_run(result)

    async def download_output(
        self,
        evaluation_id: str,
        run_id: str,
    ) -> OutputDownload:
        page = await self._retry(
            lambda: asyncio.to_thread(
                self._openai.evals.runs.output_items.list,
                run_id=run_id,
                eval_id=evaluation_id,
                limit=100,
            )
        )
        items = [dict(to_primitive(item)) for item in page]
        return OutputDownload(items=items, native=native_json(items))

    async def delete_run(self, evaluation_id: str, run_id: str) -> None:
        await self._retry(
            lambda: asyncio.to_thread(
                self._openai.evals.runs.delete,
                run_id=run_id,
                eval_id=evaluation_id,
            )
        )

    async def delete_evaluation(self, evaluation_id: str) -> None:
        await self._retry(
            lambda: asyncio.to_thread(
                self._openai.evals.delete,
                eval_id=evaluation_id,
            )
        )

    async def delete_taxonomy(self, name: str) -> None:
        await self._retry(
            lambda: asyncio.to_thread(
                self._project.beta.evaluation_taxonomies.delete,
                name=name,
            )
        )

    async def delete_target(self, target: TemporaryTarget) -> None:
        if not target.temporary:
            return
        await self._retry(
            lambda: asyncio.to_thread(
                self._project.agents.delete,
                agent_name=target.name,
            )
        )

    async def close(self) -> None:
        await asyncio.to_thread(self._project.close)
        if self._credential is not None:
            await asyncio.to_thread(self._credential.close)

    async def _retry(self, operation: Callable[[], Awaitable[T]]) -> T:
        attempts = self._polling.max_transient_retries + 1
        for attempt in range(attempts):
            try:
                return await operation()
            except Exception as error:
                if attempt + 1 >= attempts or not _is_transient(error):
                    raise
                delay = min(
                    self._polling.max_retry_delay_seconds,
                    self._polling.base_retry_delay_seconds * (2**attempt),
                )
                await self._sleep(delay + random.uniform(0, delay * 0.1))
        raise AssertionError("retry loop exhausted")


def _remote_run(value: Any) -> RemoteRun:
    return RemoteRun(
        id=str(value.id),
        status=str(value.status).lower(),
        value=dict(to_primitive(value)),
    )


def _risk_category(value: str) -> RiskCategory | str:
    for category in RiskCategory:
        if category.value.casefold() == value.casefold():
            return category
    return value


def _is_transient(error: Exception) -> bool:
    if isinstance(
        error,
        (
            ServiceRequestError,
            ServiceResponseError,
            APIConnectionError,
            APITimeoutError,
        ),
    ):
        return True
    if isinstance(error, (HttpResponseError, APIStatusError)):
        status = getattr(error, "status_code", None)
        if status is None:
            response = getattr(error, "response", None)
            status = getattr(response, "status_code", None)
        return status in {408, 429, 500, 502, 503, 504}
    return False


async def poll_run(
    client: CloudRedTeamClient,
    evaluation_id: str,
    run: RemoteRun,
    polling: PollingConfig,
    *,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    monotonic: Callable[[], float] = time.monotonic,
) -> RemoteRun:
    terminal = {"completed", "failed", "canceled", "cancelled"}
    current = run
    deadline = monotonic() + polling.timeout_seconds
    while current.status not in terminal:
        if monotonic() >= deadline:
            raise TimeoutError(
                f"red-team run {run.id} did not finish before timeout"
            )
        await sleep(polling.interval_seconds)
        current = await client.get_run(evaluation_id, run.id)
    return current
