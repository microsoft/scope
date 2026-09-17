from __future__ import annotations

from typing import Any

import pytest
from azure.core.exceptions import ServiceRequestError

from static_prompt_evals.red_team.cloud import (
    AzureCloudRedTeamClient,
    TemporaryTarget,
)
from static_prompt_evals.red_team.models import PollingConfig


class FakeRunResponse:
    id = "run-1"
    status = "queued"

    def model_dump(self, mode: str) -> dict[str, Any]:
        assert mode == "json"
        return {"id": self.id, "status": self.status}


class FakeRuns:
    def __init__(self) -> None:
        self.kwargs: dict[str, Any] | None = None

    def create(self, **kwargs: Any) -> FakeRunResponse:
        self.kwargs = kwargs
        return FakeRunResponse()


class FakeOpenAI:
    def __init__(self) -> None:
        self.evals = type("Evals", (), {"runs": FakeRuns()})()


class FakeAgents:
    def __init__(self) -> None:
        self.kwargs: dict[str, Any] | None = None
        self.deleted_agent_name: str | None = None

    def create_version(self, **kwargs: Any) -> Any:
        self.kwargs = kwargs
        return type(
            "AgentVersion",
            (),
            {"name": kwargs["agent_name"], "version": "1", "id": "agent-1"},
        )()

    def delete(self, *, agent_name: str) -> None:
        self.deleted_agent_name = agent_name


class FakeProject:
    def __init__(self) -> None:
        self.agents = FakeAgents()


@pytest.mark.asyncio
async def test_create_target_preserves_production_tool_schema() -> None:
    client = AzureCloudRedTeamClient.__new__(AzureCloudRedTeamClient)
    client._project = FakeProject()

    target = await client.create_target(
        name="scope-target",
        deployment="gpt-test",
        instructions="trusted instructions",
        tools=[
            {
                "name": "read_file",
                "description": "Read a file",
                "parameters": {
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                    "required": ["path"],
                },
            }
        ],
        metadata={"scopeTemporary": "true"},
    )

    definition = client._project.agents.kwargs["definition"].as_dict()
    assert definition["tools"] == [
        {
            "name": "read_file",
            "description": "Read a file",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
            "strict": False,
            "type": "function",
        }
    ]
    assert target.tool_descriptions == (
        {"name": "read_file", "description": "Read a file"},
    )


@pytest.mark.asyncio
async def test_delete_target_removes_the_temporary_agent() -> None:
    client = AzureCloudRedTeamClient.__new__(AzureCloudRedTeamClient)
    client._project = FakeProject()
    client._polling = PollingConfig.model_validate(
        {
            "intervalSeconds": 1,
            "timeoutSeconds": 10,
            "maxTransientRetries": 0,
            "baseRetryDelaySeconds": 0.01,
            "maxRetryDelaySeconds": 0.02,
        }
    )
    target = TemporaryTarget(
        name="scope-target",
        version="7",
        identity="agent-version-id",
    )

    await client.delete_target(target)

    assert client._project.agents.deleted_agent_name == "scope-target"


@pytest.mark.asyncio
async def test_create_run_matches_documented_cloud_red_team_shape() -> None:
    client = AzureCloudRedTeamClient.__new__(AzureCloudRedTeamClient)
    client._openai = FakeOpenAI()
    target = TemporaryTarget(
        name="scope-target",
        version="7",
        identity="agent-version-id",
        tool_descriptions=(
            {"name": "read_file", "description": "Read a file"},
        ),
    )

    run = await client.create_run(
        evaluation_id="eval-1",
        name="surface-run",
        target=target,
        taxonomy_id="azureai://taxonomy/1",
        attack_strategies=["Flip", "Base64", "IndirectJailbreak"],
        multi_turn_depth=3,
        metadata={"scopeSurface": "criterion-prompt"},
    )

    assert run.id == "run-1"
    assert client._openai.evals.runs.kwargs == {
        "eval_id": "eval-1",
        "name": "surface-run",
        "metadata": {"scopeSurface": "criterion-prompt"},
        "data_source": {
            "type": "azure_ai_red_team",
            "item_generation_params": {
                "type": "red_team_taxonomy",
                "attack_strategies": [
                    "Flip",
                    "Base64",
                    "IndirectJailbreak",
                ],
                "num_turns": 3,
                "source": {
                    "type": "file_id",
                    "id": "azureai://taxonomy/1",
                },
            },
            "target": {
                "type": "azure_ai_agent",
                "name": "scope-target",
                "version": "7",
                "tool_descriptions": [
                    {"name": "read_file", "description": "Read a file"}
                ],
            },
        },
    }


@pytest.mark.asyncio
async def test_idempotent_cloud_calls_use_bounded_transient_retry() -> None:
    client = AzureCloudRedTeamClient.__new__(AzureCloudRedTeamClient)
    client._polling = PollingConfig.model_validate(
        {
            "intervalSeconds": 1,
            "timeoutSeconds": 10,
            "maxTransientRetries": 2,
            "baseRetryDelaySeconds": 0.01,
            "maxRetryDelaySeconds": 0.02,
        }
    )
    sleeps: list[float] = []

    async def fake_sleep(delay: float) -> None:
        sleeps.append(delay)

    client._sleep = fake_sleep
    calls = 0

    async def operation() -> str:
        nonlocal calls
        calls += 1
        if calls < 3:
            raise ServiceRequestError("temporary network failure")
        return "ok"

    assert await client._retry(operation) == "ok"
    assert calls == 3
    assert len(sleeps) == 2
