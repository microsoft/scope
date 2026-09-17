import pytest

from static_prompt_evals.red_team.composition import (
    build_prompt_agent_template,
)
from static_prompt_evals.red_team.models import ComposedRequest


def test_final_user_attack_uses_direct_prompt_agent_target() -> None:
    composed = ComposedRequest.model_validate(
        {
            "adapterId": "criterion-prompt",
            "messages": [
                {"role": "system", "content": "Trusted judge instructions"},
                {"role": "user", "content": "{{ATTACK}}"},
            ],
            "tools": [],
            "compositionFingerprint": "abc12345",
            "sourceRevision": "revision-1",
        }
    )

    template = build_prompt_agent_template(composed, "{{ATTACK}}")

    assert template.fidelity == "prompt-agent-user-message"
    assert template.direct_model is False
    assert "Trusted judge instructions" in template.instructions
    assert "{{ATTACK}}" not in template.instructions


def test_non_user_insertion_uses_role_emulation_without_static_copy() -> None:
    composed = ComposedRequest.model_validate(
        {
            "adapterId": "report-system-prompt",
            "messages": [
                {
                    "role": "system",
                    "content": "Trusted before {{ATTACK}} trusted after",
                },
                {"role": "user", "content": "Generate the report"},
            ],
            "tools": [{"type": "function", "name": "lookup"}],
            "compositionFingerprint": "abc12345",
            "sourceRevision": "revision-1",
        }
    )

    template = build_prompt_agent_template(composed, "{{ATTACK}}")

    assert template.fidelity == "prompt-agent-role-emulation"
    assert template.direct_model is False
    assert "Substitute it exactly once" in template.instructions
    assert template.tools == [{"type": "function", "name": "lookup"}]


def test_composition_rejects_multiple_attack_slots() -> None:
    composed = ComposedRequest.model_validate(
        {
            "adapterId": "bad",
            "messages": [
                {"role": "system", "content": "{{ATTACK}}"},
                {"role": "user", "content": "{{ATTACK}}"},
            ],
            "compositionFingerprint": "abc12345",
            "sourceRevision": "revision-1",
        }
    )

    with pytest.raises(ValueError, match="exactly one message"):
        build_prompt_agent_template(composed, "{{ATTACK}}")


def test_bare_user_surface_uses_existing_model_deployment_directly() -> None:
    composed = ComposedRequest.model_validate(
        {
            "adapterId": "red-team/task-scenario-prompt",
            "messages": [{"role": "user", "content": "{{ATTACK}}"}],
            "compositionFingerprint": "abc12345",
            "sourceRevision": "revision-1",
        }
    )

    template = build_prompt_agent_template(composed, "{{ATTACK}}")

    assert template.direct_model is True
    assert template.fidelity == "azure-ai-model-user-message"
    assert template.instructions == ""
