"""Orchestrate one attributable cloud red-team run per prompt surface."""

from __future__ import annotations

import os
import re
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable, Iterable

from static_prompt_evals.artifacts import redact_error, write_json
from static_prompt_evals.config import RunConfig

from .cloud import (
    AzureCloudRedTeamClient,
    CloudRedTeamClient,
    RemoteRun,
    TaxonomyResource,
    TemporaryTarget,
    poll_run,
)
from .composition import (
    SubprocessSurfaceComposer,
    SurfaceComposer,
    build_prompt_agent_template,
)
from .config import load_red_team_settings, load_surface_profiles
from .models import RedTeamSettings, SurfaceProfile
from .results import aggregate_surface, persist_native_result


def _truthy(value: str | None) -> bool:
    return bool(value and value.casefold() in {"1", "true", "yes", "on"})


def _resource_name(prefix: str, surface_id: str) -> str:
    base = re.sub(r"[^a-z0-9-]", "-", f"{prefix}-{surface_id}".lower())
    base = re.sub(r"-+", "-", base).strip("-")
    return f"{base[:48]}-{uuid.uuid4().hex[:8]}"


def _selected_profiles(
    profiles: Iterable[SurfaceProfile],
    selected: set[str] | None,
) -> list[SurfaceProfile]:
    result = list(profiles)
    if selected is None:
        return result
    available = {profile.id.value for profile in result}
    unknown = selected - available
    if unknown:
        raise ValueError(f"unknown red-team surfaces: {sorted(unknown)}")
    chosen = [profile for profile in result if profile.id.value in selected]
    if not chosen:
        raise ValueError("at least one red-team surface must be selected")
    return chosen


def _safe_run_metadata(run: RemoteRun) -> dict[str, Any]:
    value = run.value
    remote_error = value.get("error")
    return {
        "id": run.id,
        "status": run.status,
        "createdAt": value.get("created_at"),
        "resultCounts": value.get("result_counts"),
        "perTestingCriteriaResults": value.get(
            "per_testing_criteria_results"
        ),
        "error": (
            redact_error(RuntimeError(str(remote_error)))
            if remote_error
            else None
        ),
    }


async def _cleanup_surface(
    client: CloudRedTeamClient,
    evaluation_id: str,
    run_id: str | None,
    taxonomy: TaxonomyResource | None,
    target: TemporaryTarget | None,
) -> list[str]:
    errors: list[str] = []
    operations: list[tuple[str, Callable[[], Any]]] = []
    if run_id is not None:
        operations.append(
            (
                f"run {run_id}",
                lambda: client.delete_run(evaluation_id, run_id),
            )
        )
    if taxonomy is not None:
        operations.append(
            (
                f"taxonomy {taxonomy.name}",
                lambda: client.delete_taxonomy(taxonomy.name),
            )
        )
    if target is not None and target.temporary:
        operations.append(
            (
                f"target {target.name}/{target.version}",
                lambda: client.delete_target(target),
            )
        )
    for label, operation in operations:
        try:
            await operation()
        except Exception as error:
            errors.append(f"{label}: {redact_error(error)}")
    return errors


async def _run_surface(
    profile: SurfaceProfile,
    settings: RedTeamSettings,
    client: CloudRedTeamClient,
    composer: SurfaceComposer,
    evaluation_id: str,
    deployment: str,
    track_dir: Path,
    keep_remote: bool,
) -> dict[str, Any]:
    surface_dir = track_dir / profile.id.value
    surface_dir.mkdir(parents=True, exist_ok=True)
    started_at = datetime.now(UTC).isoformat()
    target: TemporaryTarget | None = None
    taxonomy: TaxonomyResource | None = None
    run: RemoteRun | None = None
    cleanup_errors: list[str] = []
    summary: dict[str, Any]

    try:
        composed = await composer.compose(
            profile,
            settings.attack_placeholder,
        )
        template = build_prompt_agent_template(
            composed,
            settings.attack_placeholder,
        )
        if template.direct_model:
            target = TemporaryTarget(
                name=deployment,
                version="",
                identity=deployment,
                kind="azure_ai_model",
                temporary=False,
            )
        else:
            target_name = _resource_name(
                settings.resource_prefix,
                profile.id.value,
            )
            target = await client.create_target(
                name=target_name,
                deployment=deployment,
                instructions=template.instructions,
                tools=template.tools,
                metadata={
                    "scopeSurface": profile.id.value,
                    "scopeAdapter": profile.adapter_id,
                    "scopeFingerprint": composed.composition_fingerprint,
                    "scopeTemporary": "true",
                },
            )
        taxonomy_name = _resource_name(
            settings.resource_prefix,
            f"{profile.id.value}-taxonomy",
        )
        taxonomy = await client.create_taxonomy(
            taxonomy_name,
            target,
            settings.risk_categories,
        )
        write_json(surface_dir / "taxonomy.json", taxonomy.value)

        run = await client.create_run(
            evaluation_id=evaluation_id,
            name=f"{target.name}-run",
            target=target,
            taxonomy_id=taxonomy.id,
            attack_strategies=settings.attack_strategies,
            multi_turn_depth=settings.multi_turn_depth,
            metadata={
                "scopeSurface": profile.id.value,
                "scopeAdapter": profile.adapter_id,
                "scopeFingerprint": composed.composition_fingerprint,
                "scopeSourceRevision": composed.source_revision,
                "scopeCanary": str(profile.canary).lower(),
            },
        )
        run = await poll_run(
            client,
            evaluation_id,
            run,
            settings.polling,
        )
        output = await client.download_output(evaluation_id, run.id)
        output_path = persist_native_result(
            surface_dir,
            "output-items",
            output.native,
        )
        aggregate = aggregate_surface(profile.id.value, output.items)
        remote_counts = run.value.get("result_counts")
        remote_errored = (
            remote_counts.get("errored", 0)
            if isinstance(remote_counts, dict)
            else 0
        )
        summary = {
            "status": (
                "succeeded"
                if run.status == "completed"
                and aggregate["erroredItems"] == 0
                and not remote_errored
                else "infrastructure-failed"
            ),
            "startedAt": started_at,
            "completedAt": datetime.now(UTC).isoformat(),
            "surfaceProfile": profile.id.value,
            "adapterId": profile.adapter_id,
            "canary": profile.canary,
            "targetMode": template.fidelity,
            "compositionFingerprint": composed.composition_fingerprint,
            "sourceRevision": composed.source_revision,
            "evaluationId": evaluation_id,
            "runId": run.id,
            "target": {
                "name": target.name,
                "version": target.version,
                "identity": target.identity,
                "temporary": target.temporary,
                "kind": target.kind,
            },
            "taxonomyId": taxonomy.id,
            "attackConfiguration": {
                "strategies": settings.attack_strategies,
                "objectiveCount": "service-default",
                "multiTurnDepth": settings.multi_turn_depth,
            },
            "remote": _safe_run_metadata(run),
            "nativeOutput": output_path.name,
            **aggregate,
        }
    except Exception as error:
        summary = {
            "status": "infrastructure-failed",
            "startedAt": started_at,
            "completedAt": datetime.now(UTC).isoformat(),
            "surfaceProfile": profile.id.value,
            "adapterId": profile.adapter_id,
            "canary": profile.canary,
            "evaluationId": evaluation_id,
            "runId": run.id if run else None,
            "target": (
                {
                    "name": target.name,
                    "version": target.version,
                    "identity": target.identity,
                    "temporary": target.temporary,
                    "kind": target.kind,
                }
                if target
                else None
            ),
            "taxonomyId": taxonomy.id if taxonomy else None,
            "error": redact_error(error),
        }
    finally:
        if keep_remote:
            summary["cleanup"] = {"status": "skipped", "keepRemote": True}
        else:
            cleanup_errors = await _cleanup_surface(
                client,
                evaluation_id,
                run.id if run else None,
                taxonomy,
                target,
            )
            summary["cleanup"] = {
                "status": "failed" if cleanup_errors else "succeeded",
                "keepRemote": False,
                "errors": cleanup_errors,
            }
            if cleanup_errors:
                summary["status"] = "infrastructure-failed"
        write_json(surface_dir / "summary.json", summary)
    return summary


async def run_red_team(
    config: RunConfig,
    run_dir: Path,
    *,
    client: CloudRedTeamClient | None = None,
    composer: SurfaceComposer | None = None,
    selected_surfaces: set[str] | None = None,
    keep_remote: bool | None = None,
) -> dict[str, Any]:
    settings = load_red_team_settings(config.red_team_config_path)
    inventory = load_surface_profiles(config.surface_profiles_path)
    selected = selected_surfaces
    if selected is None:
        configured = os.environ.get("SCOPE_RED_TEAM_SURFACES")
        if configured:
            selected = {
                item.strip() for item in configured.split(",") if item.strip()
            }
    profiles = _selected_profiles(inventory.profiles, selected)
    deployment = os.environ.get(settings.model_deployment_env)
    if not deployment:
        raise ValueError(
            f"{settings.model_deployment_env} is required for red teaming"
        )
    preserve_remote = (
        _truthy(os.environ.get(settings.keep_remote_env))
        if keep_remote is None
        else keep_remote
    )
    owned_client = client is None
    cloud = client or AzureCloudRedTeamClient.from_environment(settings)
    target_composer = composer or SubprocessSurfaceComposer(
        settings.adapter_command,
        config.package_root,
    )
    evaluation_id: str | None = None
    evaluation_cleanup_error: str | None = None
    surface_summaries: list[dict[str, Any]] = []
    started_at = datetime.now(UTC).isoformat()

    try:
        evaluation_id = await cloud.create_evaluation(
            _resource_name(settings.resource_prefix, "evaluation"),
            settings.evaluators,
        )
        for profile in profiles:
            surface_summaries.append(
                await _run_surface(
                    profile,
                    settings,
                    cloud,
                    target_composer,
                    evaluation_id,
                    deployment,
                    run_dir,
                    preserve_remote,
                )
            )
    finally:
        if evaluation_id and not preserve_remote:
            try:
                await cloud.delete_evaluation(evaluation_id)
            except Exception as error:
                evaluation_cleanup_error = redact_error(error)
        if owned_client:
            await cloud.close()

    statuses = {summary["status"] for summary in surface_summaries}
    status = (
        "succeeded"
        if statuses <= {"succeeded"} and evaluation_cleanup_error is None
        else "infrastructure-failed"
    )
    result = {
        "status": status,
        "startedAt": started_at,
        "completedAt": datetime.now(UTC).isoformat(),
        "evaluationId": evaluation_id,
        "modelDeployment": deployment,
        "keepRemote": preserve_remote,
        "surfaceCount": len(surface_summaries),
        "successfulSurfaceCount": sum(
            summary["status"] == "succeeded"
            for summary in surface_summaries
        ),
        "totalItems": sum(
            int(summary.get("totalItems", 0))
            for summary in surface_summaries
        ),
        "successfulAttacks": sum(
            int(summary.get("successfulAttacks", 0))
            for summary in surface_summaries
        ),
        "surfaces": surface_summaries,
        "evaluationCleanup": {
            "status": (
                "skipped"
                if preserve_remote
                else "failed"
                if evaluation_cleanup_error
                else "succeeded"
            ),
            "error": evaluation_cleanup_error,
        },
    }
    total_items = result["totalItems"]
    result["attackSuccessRate"] = (
        result["successfulAttacks"] / total_items if total_items else 0.0
    )
    write_json(run_dir / "summary.json", result)
    return result
