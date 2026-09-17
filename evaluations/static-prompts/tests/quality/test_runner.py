import json
from pathlib import Path

from static_prompt_evals.config import RunConfig
from static_prompt_evals.quality.azure import AzureRuntime
from static_prompt_evals.quality.runner import run_quality_engine

PACKAGE_ROOT = Path(__file__).resolve().parents[2]


def test_quality_engine_writes_rows_findings_and_summary(tmp_path: Path) -> None:
    dataset_path = tmp_path / "cases.jsonl"
    dataset_path.write_text(
        json.dumps(
            {
                "id": "criteria-case",
                "family": "criteria-authoring",
                "variant": "default",
                "input": {
                    "request": "Create a criterion for evidence use",
                    "candidates": [],
                },
                "expected_behavior": "The criterion should require repository and tool evidence.",
                "expectedLabels": {"criteria_evidence_source": "both"},
            }
        )
        + "\n",
        encoding="utf-8",
    )
    track_dir = tmp_path / "quality"
    run_config = RunConfig(
        package_root=PACKAGE_ROOT,
        repo_root=PACKAGE_ROOT.parents[1],
        run_dir=tmp_path,
        manifest_path=PACKAGE_ROOT / "evaluation-manifest.yaml",
        dataset_path=dataset_path,
        surface_profiles_path=tmp_path / "unused-profiles.yaml",
        red_team_config_path=tmp_path / "unused-red-team.yaml",
        samples=3,
        smoke=False,
    )

    def generator(input_path: Path, output_path: Path, samples: int, smoke: bool):
        del input_path, smoke
        with output_path.open("w", encoding="utf-8") as stream:
            for sample in range(samples):
                stream.write(
                    json.dumps(
                        {
                            "id": "criteria-case",
                            "family": "criteria-authoring",
                            "variant": "default",
                            "sampleIndex": sample,
                            "output": {
                                "id": "uses_both_evidence",
                                "prompt": "Verify the implementation using repository and tool evidence.",
                                "dependencies": [],
                            },
                        }
                    )
                    + "\n"
                )

    def fake_evaluate(**kwargs):
        evaluator = next(iter(kwargs["evaluators"]))
        rows = []
        for line in Path(kwargs["data"]).read_text(encoding="utf-8").splitlines():
            source = json.loads(line)
            row = {"inputs.row_id": source["row_id"]}
            if evaluator == "criteria_evidence_source":
                row.update(
                    {
                        f"outputs.{evaluator}.label": "both",
                        f"outputs.{evaluator}.passed": True,
                    }
                )
            else:
                row.update(
                    {
                        f"outputs.{evaluator}.score": 4,
                        f"outputs.{evaluator}.passed": True,
                    }
                )
            rows.append(row)
        return {
            "rows": rows,
            "metrics": {f"{evaluator}.pass_rate": 1.0},
            "studio_url": None,
        }

    runtime = AzureRuntime(
        model_config={
            "azure_endpoint": "https://example.invalid",
            "azure_deployment": "grader",
            "api_key": "not-a-real-key",
        },
        credential=None,
        project=None,
        deployment="grader",
        sdk_version="1.18.5",
        auth_mode="api-key",
    )

    summary = run_quality_engine(
        run_config,
        track_dir,
        generator=generator,
        evaluate_callable=fake_evaluate,
        azure_runtime=runtime,
    )

    assert summary["status"] == "succeeded"
    assert summary["samples"] == 3
    assert (track_dir / "production-rows.jsonl").is_file()
    assert (track_dir / "deterministic-row-results.jsonl").is_file()
    assert (track_dir / "azure-row-results.jsonl").is_file()
    assert (track_dir / "azure-native" / "index.json").is_file()
    assert (track_dir / "findings.json").is_file()
    assert (track_dir / "summary.json").is_file()
    assert (track_dir / "decision-summary.json").is_file()
    assert not (track_dir / "decision.json").exists()
