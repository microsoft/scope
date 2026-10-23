# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""Dataset + preflight helpers for the optimizer.

The dataset is intentionally tiny: every example is one full (minutes-long)
Scope agent run, so a handful of tasks is plenty for a demonstration. Each
example references **existing** Scope criterion ids; ``preflight_criteria``
validates them before any expensive run starts.
"""

from __future__ import annotations

import asyncio
from typing import Any, Mapping, Sequence

import httpx

from .scope_client import ScopeClient, SystemicScopeError

DataInst = dict[str, Any]


# The seed AGENTS.md GEPA mutates. It starts EMPTY on purpose: the whole point of
# this experiment is to discover, from scratch, the AGENTS.md guidance that makes
# the agent reliably satisfy the task's criteria.
SEED_AGENTS_MD = ""

# The single task we optimize the AGENTS.md for.
BLOG_TASK = (
    "Create a blogging platform inspired by Medium using Python and Django, "
    "utilizing a nonrelational database for data storage and management. "
    "Must run in the Cloud."
)

# Criteria requested per run. We request the FULL ancestor closure of the target
# leaf (uses_azure_documentdb), not just the leaf, so scoring is graded:
#   uses_database -> uses_document_oriented_db -> uses_azure_documentdb
#   uses_azure ----------------------------------^
# Partial credit (e.g. "uses a document DB but not on Azure") gives GEPA a much
# denser gradient than a single 0/1 leaf, while the leaf remains the real goal.
BLOG_CRITERIA = [
    "uses_database",
    "uses_document_oriented_db",
    "uses_azure",
    "uses_azure_documentdb",
]


def default_dataset() -> tuple[list[DataInst], list[DataInst]]:
    """Return ``(trainset, valset)``.

    A single seed task (the Medium-style Django blog on Azure Cosmos DB). Both
    splits point at the same example: GEPA reflects on it (train) and selects on
    it (val). ``preflight_criteria`` validates the ids before any expensive run.
    """
    example: DataInst = {"task": BLOG_TASK, "criteria": list(BLOG_CRITERIA)}
    trainset: list[DataInst] = [example]
    valset: list[DataInst] = [dict(example)]
    return trainset, valset


def collect_criteria(datasets: Sequence[Sequence[Mapping[str, Any]]]) -> set[str]:
    ids: set[str] = set()
    for ds in datasets:
        for ex in ds:
            for cid in ex.get("criteria") or []:
                ids.add(cid)
    return ids


async def _preflight_async(client: ScopeClient, criteria: Sequence[str]) -> list[str]:
    missing: list[str] = []
    async with httpx.AsyncClient(timeout=client.timeout_seconds) as http:
        for cid in criteria:
            doc = await client.get_criterion(http, cid)
            if doc is None:
                missing.append(cid)
    return missing


def preflight_criteria(client: ScopeClient, criteria: Sequence[str]) -> None:
    """Raise ``SystemicScopeError`` if any criterion id does not exist."""
    if not criteria:
        raise SystemicScopeError("Dataset has no criteria; every example needs >=1.")
    missing = asyncio.run(_preflight_async(client, list(criteria)))
    if missing:
        raise SystemicScopeError(
            f"Unknown criterion ids (create them or fix the dataset): {sorted(missing)}"
        )
