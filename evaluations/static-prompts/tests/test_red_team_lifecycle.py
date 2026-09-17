from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from static_prompt_evals.config import RunConfig
from static_prompt_evals.red_team.cloud import (
    OutputDownload,
    RemoteRun,
    TaxonomyResource,
    TemporaryTarget,
    poll_run,
)
from static_prompt_evals.red_team.config import load_red_team_settings
from static_prompt_evals.red_team.models import (
    ComposedRequest,
    EvaluatorConfig,
    SurfaceProfile,
)
from static_prompt_evals.red_team.results import NativeResult
from static_prompt_evals.red_team.runner import run_red_team


PACKAGE_ROOT = Path(__file__).resolve().parents[1]


class FakeComposer:
    async def compose(
        self,
        profile: SurfaceProfile,
        attack_placeholder: str,
    ) -> ComposedRequest:
        messages = (
            [{"role": "user", "content": attack_placeholder}]
            if profile.id.value in {"task-scenario-prompt", "gate-prompt"}
            else [
                {"role": "system", "content": "Trusted production wrapper"},
                {"role": "user", "content": attack_placeholder},
            ]
        )
        return ComposedRequest.model_validate(
            {
                "adapterId": profile.adapter_id,
                "messages": messages,
                "tools": [],
                "compositionFingerprint": f"fingerprint-{profile.id.value}",
                "sourceRevision": "test-revision",
            }
        )


class FakeCloudClient:
    def __init__(self) -> None:
        self.created_targets: list[TemporaryTarget] = []
        self.deleted_targets: list[TemporaryTarget] = []
        self.deleted_taxonomies: list[str] = []
        self.deleted_runs: list[tuple[str, str]] = []
        self.deleted_evaluations: list[str] = []
        self.run_calls: list[dict[str, Any]] = []
        self.closed = False

    async def create_evaluation(
        self,
        name: str,
        evaluators: list[EvaluatorConfig],
    ) -> str:
        assert name.startswith("scope-static-redteam-evaluation-")
        assert len(evaluators) == 3
        return "eval-1"

    async def create_target(
        self,
        name: str,
        deployment: str,
        instructions: str,
        tools: list[dict[str, object]],
        metadata: dict[str, str],
    ) -> TemporaryTarget:
        assert deployment == "gpt-test"
        assert "Trusted production wrapper" in instructions
        target = TemporaryTarget(
            name=name,
            version=str(len(self.created_targets) + 1),
            identity=f"target-{len(self.created_targets) + 1}",
        )
        self.created_targets.append(target)
        return target

    async def create_taxonomy(
        self,
        name: str,
        target: TemporaryTarget,
        risk_categories: list[str],
    ) -> TaxonomyResource:
        assert target in self.created_targets or not target.temporary
        assert "ProhibitedActions" in risk_categories
        return TaxonomyResource(
            name=name,
            id=f"taxonomy://{name}",
            value={"id": f"taxonomy://{name}", "name": name},
        )

    async def create_run(self, **kwargs: Any) -> RemoteRun:
        self.run_calls.append(kwargs)
        run_id = f"run-{len(self.run_calls)}"
        return RemoteRun(
            id=run_id,
            status="completed",
            value={"id": run_id, "status": "completed"},
        )

    async def get_run(
        self,
        evaluation_id: str,
        run_id: str,
    ) -> RemoteRun:
        return RemoteRun(
            id=run_id,
            status="completed",
            value={
                "id": run_id,
                "status": "completed",
                "result_counts": {
                    "total": 1,
                    "passed": 0,
                    "failed": 1,
                    "errored": 0,
                },
            },
        )

    async def download_output(
        self,
        evaluation_id: str,
        run_id: str,
    ) -> OutputDownload:
        items = [
            {
                "id": f"item-{run_id}",
                "datasource_item": {"attack_strategy": "Flip"},
                "results": [
                    {
                        "name": "Prohibited Actions",
                        "passed": False,
                        "score": 0,
                    }
                ],
            }
        ]
        return OutputDownload(
            items=items,
            native=NativeResult(
                content=json.dumps(items).encode(),
                media_type="application/json",
            ),
        )

    async def delete_run(self, evaluation_id: str, run_id: str) -> None:
        self.deleted_runs.append((evaluation_id, run_id))

    async def delete_evaluation(self, evaluation_id: str) -> None:
        self.deleted_evaluations.append(evaluation_id)

    async def delete_taxonomy(self, name: str) -> None:
        self.deleted_taxonomies.append(name)

    async def delete_target(self, target: TemporaryTarget) -> None:
        self.deleted_targets.append(target)

    async def close(self) -> None:
        self.closed = True


class FailingRunClient(FakeCloudClient):
    async def create_run(self, **kwargs: Any) -> RemoteRun:
        self.run_calls.append(kwargs)
        raise RuntimeError("run creation failed")


def _run_config(tmp_path: Path) -> RunConfig:
    return RunConfig(
        package_root=PACKAGE_ROOT,
        repo_root=PACKAGE_ROOT.parents[1],
        run_dir=tmp_path,
        manifest_path=PACKAGE_ROOT / "evaluation-manifest.yaml",
        dataset_path=PACKAGE_ROOT / "datasets" / "quality-cases.jsonl",
        surface_profiles_path=(
            PACKAGE_ROOT / "red-team" / "surface-profiles.yaml"
        ),
        red_team_config_path=PACKAGE_ROOT / "red-team" / "red-team.yaml",
        samples=1,
        smoke=True,
    )


@pytest.mark.asyncio
async def test_lifecycle_runs_each_selected_surface_and_cleans_exact_resources(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AZURE_AI_MODEL_DEPLOYMENT_NAME", "gpt-test")
    cloud = FakeCloudClient()

    summary = await run_red_team(
        config=_run_config(tmp_path),
        run_dir=tmp_path,
        client=cloud,
        composer=FakeComposer(),
        selected_surfaces={"task-scenario-prompt", "criterion-prompt"},
    )

    assert summary["status"] == "succeeded"
    assert summary["surfaceCount"] == 2
    assert summary["successfulAttacks"] == 2
    assert summary["attackSuccessRate"] == 1
    assert cloud.deleted_targets == cloud.created_targets
    assert len(cloud.created_targets) == 1
    assert cloud.deleted_runs == [("eval-1", "run-1"), ("eval-1", "run-2")]
    assert len(cloud.deleted_taxonomies) == 2
    assert all(
        name.startswith("scope-static-redteam-")
        for name in cloud.deleted_taxonomies
    )
    assert cloud.deleted_evaluations == ["eval-1"]
    assert all(
        call["multi_turn_depth"] == 5
        and call["attack_strategies"]
        == ["Flip", "Base64", "IndirectJailbreak"]
        for call in cloud.run_calls
    )
    assert (
        tmp_path / "task-scenario-prompt" / "output-items.json"
    ).exists()
    persisted = json.loads((tmp_path / "summary.json").read_text())
    assert persisted["surfaces"][0]["canary"] is True


@pytest.mark.asyncio
async def test_keep_remote_preserves_only_created_resource_ids(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AZURE_AI_MODEL_DEPLOYMENT_NAME", "gpt-test")
    cloud = FakeCloudClient()

    summary = await run_red_team(
        _run_config(tmp_path),
        tmp_path,
        client=cloud,
        composer=FakeComposer(),
        selected_surfaces={"criterion-prompt"},
        keep_remote=True,
    )

    assert summary["status"] == "succeeded"
    assert not cloud.deleted_targets
    assert not cloud.deleted_taxonomies
    assert not cloud.deleted_runs
    assert not cloud.deleted_evaluations
    assert summary["surfaces"][0]["cleanup"] == {
        "status": "skipped",
        "keepRemote": True,
    }


@pytest.mark.asyncio
async def test_partial_creation_failure_still_cleans_exact_resources(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AZURE_AI_MODEL_DEPLOYMENT_NAME", "gpt-test")
    cloud = FailingRunClient()

    summary = await run_red_team(
        _run_config(tmp_path),
        tmp_path,
        client=cloud,
        composer=FakeComposer(),
        selected_surfaces={"criterion-prompt"},
    )

    assert summary["status"] == "infrastructure-failed"
    assert cloud.deleted_runs == []
    assert cloud.deleted_targets == cloud.created_targets
    assert len(cloud.deleted_taxonomies) == 1
    assert cloud.deleted_evaluations == ["eval-1"]
    assert summary["surfaces"][0]["cleanup"]["status"] == "succeeded"


@pytest.mark.asyncio
async def test_polling_stops_at_terminal_state_without_extra_requests() -> None:
    cloud = FakeCloudClient()
    settings = load_red_team_settings(
        PACKAGE_ROOT / "red-team" / "red-team.yaml"
    )
    sleeps: list[float] = []

    terminal = await poll_run(
        cloud,
        "eval-1",
        RemoteRun(id="run-1", status="queued", value={}),
        settings.polling.model_copy(
            update={"interval_seconds": 0.01, "timeout_seconds": 1}
        ),
        sleep=lambda delay: _record_sleep(sleeps, delay),
    )

    assert terminal.status == "completed"
    assert sleeps == [0.01]


async def _record_sleep(values: list[float], value: float) -> None:
    values.append(value)
