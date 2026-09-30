import hashlib
import json
from pathlib import Path

import pytest
import yaml

from static_prompt_evals.quality.configuration import (
    QualityConfigurationError,
    load_quality_configuration,
)
from static_prompt_evals.quality.data import read_quality_cases

PACKAGE_ROOT = Path(__file__).resolve().parents[2]


def test_rubrics_cover_all_manifest_families() -> None:
    configuration = load_quality_configuration(
        PACKAGE_ROOT / "evaluators" / "rubrics.yaml",
        manifest_path=PACKAGE_ROOT / "evaluation-manifest.yaml",
    )

    assert set(configuration.families) == {
        "criteria-authoring",
        "parent-dependency-suggestion",
        "child-dependency-suggestion",
        "task-prompt-generation",
        "task-prompt-variation",
        "prompt-feature-authoring",
        "prompt-feature-extraction",
        "judge-instructions",
        "developer-feedback",
        "run-report",
    }
    assert all(configuration.evaluator_specs(family) for family in configuration.families)
    assert len(configuration.sha256) == 64


def test_configuration_rejects_uncovered_manifest_family(tmp_path: Path) -> None:
    rubric = tmp_path / "rubrics.yaml"
    manifest = tmp_path / "manifest.yaml"
    rubric.write_text(
        """
version: 1
defaults: {}
graders:
  quality:
    type: score
    range: [1, 5]
    prompt: score it
families:
  one:
    deterministic:
      - check: generation_success
    evaluators: [quality]
    thresholds:
      generation_success: {minPassRate: 0.8}
      quality: {minPassRate: 0.5}
""",
        encoding="utf-8",
    )
    manifest.write_text(
        "qualityFamilies:\n  - id: one\n  - id: two\n",
        encoding="utf-8",
    )

    with pytest.raises(QualityConfigurationError, match="missing=\\['two'\\]"):
        load_quality_configuration(rubric, manifest_path=manifest)


@pytest.mark.parametrize("floor", [0.8, 0.95, 1.0])
def test_configuration_accepts_exact_floors_through_one_hundred_percent(tmp_path, floor):
    source = Path(__file__).resolve().parents[2] / "evaluators/rubrics.yaml"
    data = yaml.safe_load(source.read_text())
    data["families"]["criteria-authoring"]["thresholds"]["generation_success"]["minPassRate"] = floor
    path = tmp_path / "historical.yaml"
    path.write_text(yaml.safe_dump(data))
    configuration = load_quality_configuration(path)
    assert configuration.thresholds("criteria-authoring")["generation_success"]["minPassRate"] == floor


@pytest.mark.parametrize("field,value", [("minMeanScore", float("nan")), ("minPassRate", float("inf")), ("blocking", "false")])
def test_invalid_policy_values_are_rejected(tmp_path, field, value):
    source = Path(__file__).resolve().parents[2] / "evaluators/rubrics.yaml"
    data = yaml.safe_load(source.read_text())
    data["families"]["criteria-authoring"]["thresholds"]["generation_success"][field] = value
    path = tmp_path / "invalid.yaml"
    path.write_text(yaml.safe_dump(data))
    with pytest.raises(QualityConfigurationError):
        load_quality_configuration(path)


def test_quality_dataset_fallback_reads_manifest_files(
    tmp_path: Path,
) -> None:
    version_dir = tmp_path / "v1"
    version_dir.mkdir()
    contents = {
        "one.jsonl": '{"id":"one","family":"criteria-authoring"}\n',
        "two.jsonl": '{"id":"two","family":"run-report"}\n',
    }
    files = []
    for name, content in contents.items():
        (version_dir / name).write_text(content, encoding="utf-8")
        files.append(
            {
                "path": f"v1/{name}",
                "rows": 1,
                "sha256": hashlib.sha256(content.encode()).hexdigest(),
            }
        )
    (tmp_path / "manifest.json").write_text(
        json.dumps({"files": files}),
        encoding="utf-8",
    )

    rows = read_quality_cases(tmp_path / "quality-cases.jsonl")

    assert [row["id"] for row in rows] == ["one", "two"]
