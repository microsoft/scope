# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""Post-hoc lineage reconstruction from a GEPA result.

The rubber-duck critique flagged that capturing parent→child lineage *during*
evaluation (via a custom ``propose_new_texts``) is fragile: it requires
reimplementing GEPA's reflection proposer and races on shared state. Instead we
reconstruct the candidate DAG **after** ``gepa.optimize`` returns, from the
public ``result.parents`` (a ``list[list[int]]`` of parent indices per
candidate) and ``result.candidates``. This uses only GEPA's documented result
surface and cannot corrupt the optimization.

The reconstructed edges are written to ``results.json`` for inspection. The
Scope ``requests.agentsMdParentIds`` field remains available for callers that
*do* know parentage at submit time, but the optimizer does not depend on it.
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence

COMPONENT = "AGENTS.md"


def reconstruct_lineage(
    candidates: Sequence[Mapping[str, str]],
    parents: Sequence[Sequence[int] | None],
) -> list[dict[str, Any]]:
    """Build a serializable lineage DAG from GEPA candidates + parent indices.

    Each node: ``{index, parents: [int...], kind, agentsMdPreview}`` where
    ``kind`` is ``root`` (no parents), ``mutation`` (one parent) or ``merge``
    (two+ parents).
    """
    nodes: list[dict[str, Any]] = []
    for idx, cand in enumerate(candidates):
        raw_parents = parents[idx] if idx < len(parents) else None
        parent_list = [p for p in (raw_parents or []) if p is not None and p >= 0]
        if not parent_list:
            kind = "root"
        elif len(parent_list) == 1:
            kind = "mutation"
        else:
            kind = "merge"
        text = (cand or {}).get(COMPONENT, "") if isinstance(cand, Mapping) else ""
        nodes.append(
            {
                "index": idx,
                "parents": parent_list,
                "kind": kind,
                "agentsMdPreview": text[:200],
            }
        )
    return nodes
