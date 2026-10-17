# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

from gepa_optimizer.lineage import reconstruct_lineage


def test_root_mutation_merge_classification():
    candidates = [
        {"AGENTS.md": "seed"},
        {"AGENTS.md": "child of seed"},
        {"AGENTS.md": "merge of 0 and 1"},
    ]
    parents = [[], [0], [0, 1]]
    nodes = reconstruct_lineage(candidates, parents)
    assert nodes[0]["kind"] == "root"
    assert nodes[1]["kind"] == "mutation"
    assert nodes[1]["parents"] == [0]
    assert nodes[2]["kind"] == "merge"
    assert nodes[2]["parents"] == [0, 1]


def test_handles_none_and_missing_parents():
    candidates = [{"AGENTS.md": "a"}, {"AGENTS.md": "b"}]
    parents = [None]  # shorter than candidates; second has no entry
    nodes = reconstruct_lineage(candidates, parents)
    assert nodes[0]["kind"] == "root"
    assert nodes[1]["kind"] == "root"


def test_preview_truncated():
    candidates = [{"AGENTS.md": "x" * 500}]
    nodes = reconstruct_lineage(candidates, [[]])
    assert len(nodes[0]["agentsMdPreview"]) == 200


def test_negative_parent_indices_ignored():
    candidates = [{"AGENTS.md": "a"}, {"AGENTS.md": "b"}]
    parents = [[], [-1]]
    nodes = reconstruct_lineage(candidates, parents)
    assert nodes[1]["kind"] == "root"
    assert nodes[1]["parents"] == []
