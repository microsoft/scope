from pathlib import Path

import pytest
import yaml
from pydantic import ValidationError

from static_prompt_evals.red_team.config import (
    load_red_team_settings,
    load_surface_profiles,
)
from static_prompt_evals.red_team.models import SurfaceId
from static_prompt_evals.red_team.models import InsertionKind


PACKAGE_ROOT = Path(__file__).resolve().parents[1]


def test_committed_configuration_covers_all_surfaces_and_evaluators() -> None:
    profiles = load_surface_profiles(
        PACKAGE_ROOT / "red-team" / "surface-profiles.yaml"
    )
    settings = load_red_team_settings(
        PACKAGE_ROOT / "red-team" / "red-team.yaml"
    )

    assert {profile.id for profile in profiles.profiles} == set(SurfaceId)
    assert all(
        profile.adapter_id == f"red-team/{profile.id.value}"
        for profile in profiles.profiles
    )
    assert all(
        profile.canary
        for profile in profiles.profiles
        if profile.id
        in {
            SurfaceId.TASK_SCENARIO_PROMPT,
            SurfaceId.GATE_PROMPT,
            SurfaceId.AGENTS_MD,
        }
    )
    assert {
        evaluator.evaluator_name for evaluator in settings.evaluators
    } >= {
        "builtin.prohibited_actions",
        "builtin.task_adherence",
        "builtin.sensitive_data_leakage",
    }
    assert {"Flip", "Base64", "IndirectJailbreak"} <= set(
        settings.attack_strategies
    )
    persona = next(
        profile
        for profile in profiles.profiles
        if profile.id == SurfaceId.PERSONA_INSTRUCTIONS
    )
    assert persona.insertion_kind == InsertionKind.OVERRIDING_SYSTEM_INSTRUCTION
    assert "descendant guard" in persona.insertion_point


def test_surface_inventory_rejects_missing_category(tmp_path: Path) -> None:
    source = yaml.safe_load(
        (PACKAGE_ROOT / "red-team" / "surface-profiles.yaml").read_text(
            encoding="utf-8"
        )
    )
    source["profiles"].pop()
    path = tmp_path / "profiles.yaml"
    path.write_text(yaml.safe_dump(source), encoding="utf-8")

    with pytest.raises(ValidationError, match="surface inventory mismatch"):
        load_surface_profiles(path)


def test_coding_agent_surface_requires_canary_label(tmp_path: Path) -> None:
    source = yaml.safe_load(
        (PACKAGE_ROOT / "red-team" / "surface-profiles.yaml").read_text(
            encoding="utf-8"
        )
    )
    source["profiles"][0]["canary"] = False
    path = tmp_path / "profiles.yaml"
    path.write_text(yaml.safe_dump(source), encoding="utf-8")

    with pytest.raises(ValidationError, match="must be labeled as canaries"):
        load_surface_profiles(path)
