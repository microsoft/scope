import json
from dataclasses import replace
from pathlib import Path

import pytest

from static_prompt_evals.config import RunConfig
from static_prompt_evals.quality.azure import AzureRuntime
from static_prompt_evals.quality.data import read_jsonl, write_jsonl
from static_prompt_evals.quality.replay import file_hashes
from static_prompt_evals.quality.runner import run_quality_engine

ROOT = Path(__file__).resolve().parents[2]


def fake_evaluate(**kwargs):
    evaluator = next(iter(kwargs["evaluators"]))
    return {"rows": [{
        "row_id": r["row_id"],
        f"outputs.{evaluator}.label": "both",
        f"outputs.{evaluator}.score": 1 if evaluator == "criteria_evidence_source" else 4,
        f"outputs.{evaluator}.passed": True,
    } for r in read_jsonl(kwargs["data"])]}


@pytest.fixture
def source(tmp_path, monkeypatch):
    # Construct evaluators only; the injected evaluate callable never makes HTTP calls.
    monkeypatch.setattr("static_prompt_evals.quality.azure.create_evaluator", lambda spec, runtime: object())
    run = tmp_path / "source"
    cases = tmp_path / "cases.jsonl"
    write_jsonl(cases, [{"id": "case", "family": "criteria-authoring",
                        "input": {"behavior": "Use both sources"}, "expected": {"evidenceSource": "both"}}])
    config = RunConfig(ROOT, ROOT.parents[1], run, ROOT / "evaluation-manifest.yaml", cases,
                       tmp_path / "unused", tmp_path / "unused", 1, False)
    runtime = AzureRuntime({"azure_endpoint": "https://example.invalid", "azure_deployment": "grader"},
                           None, None, "grader", "1.18.5", "api-key")
    def generate(source, output, samples, smoke):
        write_jsonl(output, [{"caseId": "case", "sampleIndex": 0,
                             "output": {"suggestedId": "uses_both", "prompt": "Use both.", "dependencies": []},
                             "request": {"model": "requested", "messages": [{"role": "user", "content": "Author it."}]},
                             "invocationMetadata": {"model": "actual"}}])
    run_quality_engine(config, run / "quality", generator=generate, evaluate_callable=fake_evaluate, azure_runtime=runtime)
    return config, runtime


def test_replay_reuses_exact_responses_with_zero_generator_or_azure_calls(source, tmp_path):
    config, runtime = source
    before = file_hashes(config.run_dir)
    dest = tmp_path / "replay"
    def forbidden(*args, **kwargs):
        raise AssertionError("unexpected model or generator call")
    replay = replace(config, run_dir=dest, dataset_path=tmp_path / "DO-NOT-READ.jsonl",
                     samples=99, source_run=config.run_dir, offline=True)
    summary = run_quality_engine(replay, dest / "quality", generator=forbidden, evaluate_callable=forbidden)
    assert summary["status"] == "succeeded"
    assert summary["samples"] == 1
    assert summary["generatorCalls"] == 0
    assert (dest / "quality/decision-summary.json").is_file()
    assert (dest / "quality/production-rows.jsonl").read_bytes() == (config.run_dir / "quality/production-rows.jsonl").read_bytes()
    assert before == file_hashes(config.run_dir)
    plan = json.loads((dest / "quality/replay-plan.json").read_text())
    assert plan["affectedGraders"] == []
    assert plan["rowIdentities"][0]["actualModel"] == "actual"
    assert plan["rowIdentities"][0]["requestedModel"] == "requested"


def test_changed_grader_requires_explicit_selection(source, tmp_path, monkeypatch):
    config, runtime = source
    from static_prompt_evals.quality import replay as replay_module
    original_loader = replay_module.load_quality_configuration
    def changed(*args, **kwargs):
        old = original_loader(*args, **kwargs)
        graders = {**old.graders, "criteria_quality": {**old.graders["criteria_quality"], "prompt": "Changed rubric"}}
        return replace(old, graders=graders)
    monkeypatch.setattr(replay_module, "load_quality_configuration", changed)
    calls = []
    def evaluate(**kwargs):
        calls.append(next(iter(kwargs["evaluators"])))
        return fake_evaluate(**kwargs)
    dest = tmp_path / "selected"
    replay = replace(config, run_dir=dest, source_run=config.run_dir, regrade=("criteria-authoring/criteria_quality",))
    summary = run_quality_engine(replay, dest / "quality", evaluate_callable=evaluate, azure_runtime=runtime)
    assert summary["status"] == "succeeded"
    assert calls == ["criteria_quality"]
    plan = json.loads((dest / "quality/replay-plan.json").read_text())
    assert plan["affectedGraders"] == ["criteria-authoring/criteria_quality"]
    assert sum(p["provenance"] == "azure-rerun" for p in plan["evaluators"]) == 1


def test_source_identity_mismatch_fails_before_any_grading(source, tmp_path):
    config, _ = source
    path = config.run_dir / "quality/normalized-rows.jsonl"
    rows = read_jsonl(path)
    rows[0]["output"] = {"prompt": "tampered"}
    write_jsonl(path, rows)
    dest = tmp_path / "invalid"
    result = run_quality_engine(replace(config, run_dir=dest, source_run=config.run_dir), dest / "quality")
    assert result["status"] == "infrastructure-failed"
    assert result["decision"]["acceptance"] == "undetermined"
