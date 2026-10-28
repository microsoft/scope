# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""Entry point: optimize an AGENTS.md file with GEPA against Scope.

Budgeting note (``GEPA_MAX_METRIC_CALLS``): GEPA counts **one metric call per
dataset example evaluated**, and each metric call here is a full, slow Scope
agent run. A single optimization spends roughly::

    len(valset)                      # initial validation of the seed
  + 2 * reflection_minibatch_size    # parent + child minibatch per proposal
  + len(valset)                      # full re-validation of each accepted candidate

So keep ``valset`` tiny and ``GEPA_MAX_METRIC_CALLS`` small.
"""

from __future__ import annotations

import asyncio
import json
import os
from datetime import datetime
from pathlib import Path

import httpx
from dotenv import load_dotenv

import gepa

from .dataset import (
    SEED_AGENTS_MD,
    collect_criteria,
    default_dataset,
    preflight_criteria,
)
from .lineage import reconstruct_lineage
from .scope_adapter import ScopeAdapter
from .scope_client import ScopeClient


def _env(name: str, default: str) -> str:
    return os.getenv(name, default)


def main() -> None:
    load_dotenv()

    base_url = _env("SCOPE_API_URL", "http://localhost:3100")
    project_id = _env("SCOPE_PROJECT_ID", "")
    if not project_id:
        raise ValueError("SCOPE_PROJECT_ID is required")
    worker = _env("SCOPE_WORKER", "coder-acp-copilot")
    model = _env("SCOPE_MODEL", "claude-haiku-4.5")
    max_concurrency = int(_env("SCOPE_MAX_CONCURRENCY", "10"))
    run_timeout = float(_env("SCOPE_RUN_TIMEOUT_SECONDS", "1800"))
    poll_interval = float(_env("SCOPE_POLL_INTERVAL_SECONDS", "15"))
    max_iterations = int(_env("SCOPE_MAX_ITERATIONS", "10"))
    score_strategy = _env("SCOPE_SCORE_STRATEGY", "mean")
    max_metric_calls = int(_env("GEPA_MAX_METRIC_CALLS", "12"))
    reflection_minibatch_size = int(_env("GEPA_REFLECTION_MINIBATCH_SIZE", "2"))
    reflection_lm = _env("GEPA_REFLECTION_LM", "azure/gpt-5.5")
    configured_experiment_id = _env("SCOPE_EXPERIMENT_ID", "")
    experiment_name = _env(
        "SCOPE_EXPERIMENT_NAME",
        f"GEPA AGENTS.md optimization {datetime.now().isoformat(timespec='seconds')}",
    )

    run_dir = Path(f"runs/{datetime.now().strftime('%Y%m%d_%H%M%S')}")
    run_dir.mkdir(parents=True, exist_ok=True)

    trainset, valset = default_dataset()

    client = ScopeClient(base_url, project_id=project_id, worker=worker)

    # Preflight: fail fast on unknown criterion ids before burning agent runs.
    all_criteria = collect_criteria([trainset, valset])
    preflight_criteria(client, sorted(all_criteria))

    async def prepare_experiment() -> tuple[str, str]:
        async with httpx.AsyncClient(timeout=client.timeout_seconds) as http:
            if configured_experiment_id:
                payload = await client.get_experiment(
                    http, configured_experiment_id
                )
                experiment = payload
            else:
                payload = await client.create_experiment(
                    http,
                    name=experiment_name,
                    description=(
                        "Canonical Scope Experiment containing every request "
                        "evaluated by one GEPA optimization."
                    ),
                )
                experiment = payload.get("experiment") or {}
            experiment_id = experiment.get("experimentId")
            revision_id = (experiment.get("revision") or {}).get(
                "experimentRevisionId"
            )
            if not isinstance(experiment_id, str) or not isinstance(revision_id, str):
                raise ValueError(
                    "Experiment response omitted experiment/revision identity"
                )
            return experiment_id, revision_id

    experiment_id, experiment_revision_id = asyncio.run(prepare_experiment())

    adapter = ScopeAdapter(
        client,
        model=model,
        experiment_id=experiment_id,
        experiment_revision_id=experiment_revision_id,
        max_iterations=max_iterations,
        max_concurrency=max_concurrency,
        run_timeout_seconds=run_timeout,
        poll_interval_seconds=poll_interval,
        score_strategy=score_strategy,
    )

    print(
        f"Experiment id: {experiment_id} "
        f"(starting revision {experiment_revision_id})"
    )
    print(f"Worker={worker} model={model} strategy={score_strategy}")

    result = gepa.optimize(
        seed_candidate={"AGENTS.md": SEED_AGENTS_MD},
        trainset=trainset,
        valset=valset,
        adapter=adapter,
        reflection_lm=reflection_lm,
        max_metric_calls=max_metric_calls,
        reflection_minibatch_size=reflection_minibatch_size,
        use_merge=False,
        run_dir=str(run_dir),
    )

    payload = result.to_dict()
    # Best-effort lineage DAG reconstructed from GEPA's public parent indices.
    candidates = getattr(result, "candidates", None) or []
    parents = getattr(result, "parents", None) or []
    payload["lineage"] = reconstruct_lineage(candidates, parents)
    payload["experimentId"] = experiment_id
    payload["experimentRevisionId"] = adapter.experiment_revision_id

    (run_dir / "results.json").write_text(json.dumps(payload, indent=2, default=str))

    best = result.best_candidate.get("AGENTS.md", "")
    print(f"\nRun saved to: {run_dir}/")
    print(f"Best score: {result.val_aggregate_scores[result.best_idx]}")
    print(f"Best AGENTS.md (first 200 chars):\n{best[:200]}")


if __name__ == "__main__":
    main()
