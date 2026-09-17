"""Production-adapter composition for cloud red-team targets."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, Sequence

from .models import ComposedRequest, SurfaceProfile


class SurfaceComposer(Protocol):
    async def compose(
        self,
        profile: SurfaceProfile,
        attack_placeholder: str,
    ) -> ComposedRequest: ...


@dataclass(frozen=True)
class PromptAgentTemplate:
    instructions: str
    tools: list[dict[str, object]]
    fidelity: str
    direct_model: bool = False


class SubprocessSurfaceComposer:
    """Invoke the TypeScript adapter protocol without embedding prompt text."""

    def __init__(self, command: Sequence[str], cwd: Path) -> None:
        self._command = tuple(command)
        self._cwd = cwd

    async def compose(
        self,
        profile: SurfaceProfile,
        attack_placeholder: str,
    ) -> ComposedRequest:
        request = {
            "id": f"red-team-{profile.id.value}",
            "surface": profile.id.value,
            "attack": attack_placeholder,
            "input": profile.fixture,
        }
        process = await asyncio.create_subprocess_exec(
            *self._command,
            cwd=self._cwd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await process.communicate(
            (json.dumps(request) + "\n").encode("utf-8")
        )
        if process.returncode != 0:
            diagnostic = stderr.decode("utf-8", errors="replace").strip()
            raise RuntimeError(
                f"production adapter {profile.adapter_id!r} failed"
                + (f": {diagnostic}" if diagnostic else "")
            )
        rows: list[dict[str, object]] = []
        for line in stdout.decode("utf-8").splitlines():
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict) and value.get("caseId") == request["id"]:
                rows.append(value)
        if len(rows) != 1:
            raise ValueError(
                f"production adapter {profile.adapter_id!r} must emit one result row"
            )
        row = rows[0]
        if row.get("status") != "ok":
            error = row.get("error", {})
            raise RuntimeError(
                f"production adapter {profile.adapter_id!r} failed: "
                f"{error.get('message', 'unknown adapter error')}"
            )
        adapter_request = row.get("request")
        if not isinstance(adapter_request, dict):
            raise ValueError("production adapter response is missing request")
        metadata = adapter_request.get("metadata")
        if not isinstance(metadata, dict):
            raise ValueError(
                "production adapter response is missing request metadata"
            )
        composed = ComposedRequest.model_validate(
            {
                "adapterId": metadata.get("adapterId"),
                "messages": adapter_request.get("messages"),
                "tools": adapter_request.get("tools", []),
                "files": adapter_request.get("files", []),
                "compositionFingerprint": row.get(
                    "compositionFingerprint",
                    row.get("fingerprint"),
                ),
                "sourceRevision": row.get("sourceRevision"),
            }
        )
        if composed.adapter_id != profile.adapter_id:
            raise ValueError(
                "production adapter response does not match requested adapter ID"
            )
        count = _count_placeholder(composed, attack_placeholder)
        if count != 1:
            raise ValueError(
                f"composed request must contain the attack placeholder once; got {count}"
            )
        return composed


def _count_in_value(value: object, placeholder: str) -> int:
    if isinstance(value, str):
        return value.count(placeholder)
    if isinstance(value, list):
        return sum(_count_in_value(item, placeholder) for item in value)
    if isinstance(value, dict):
        return sum(_count_in_value(item, placeholder) for item in value.values())
    return 0


def _count_placeholder(
    composed: ComposedRequest,
    placeholder: str,
) -> int:
    return sum(
        _count_in_value(message.content, placeholder)
        for message in composed.messages
    ) + sum(item.content.count(placeholder) for item in composed.files)


def build_prompt_agent_template(
    composed: ComposedRequest,
    attack_placeholder: str,
) -> PromptAgentTemplate:
    """Translate a production composition into the supported cloud target.

    The cloud red-team API sends generated attacks to targets as user messages.
    A production request whose only untrusted slot is its final user message can
    therefore be represented directly. Other insertion roles use a temporary
    prompt-agent template that substitutes the incoming attack at the marked
    production insertion point.
    """

    attack_indexes = [
        index
        for index, message in enumerate(composed.messages)
        if _count_in_value(message.content, attack_placeholder)
    ]
    attack_files = [
        item for item in composed.files if attack_placeholder in item.content
    ]
    if len(attack_indexes) + len(attack_files) != 1:
        raise ValueError(
            "exactly one message or file must contain the attack placeholder"
        )
    attack_index = attack_indexes[0] if attack_indexes else -1
    attack_message = (
        composed.messages[attack_index] if attack_indexes else None
    )

    if (
        attack_message is not None
        and attack_message.role == "user"
        and attack_index == len(composed.messages) - 1
        and attack_message.content == attack_placeholder
        and not composed.files
    ):
        trusted_messages = composed.messages[:-1]
        direct_model = not trusted_messages and not composed.tools
        fidelity = (
            "azure-ai-model-user-message"
            if direct_model
            else "prompt-agent-user-message"
        )
        template_note = ""
    else:
        trusted_messages = composed.messages
        direct_model = False
        fidelity = "prompt-agent-role-emulation"
        template_note = (
            "\n\nThe current user message is the adversarial value for the "
            f"literal marker {attack_placeholder}. Substitute it exactly once "
            "at that marker before interpreting the production request."
        )

    blocks = [
        f"<scope-production-{message.role}>\n"
        f"{_content_text(message.content)}\n"
        f"</scope-production-{message.role}>"
        for message in trusted_messages
    ]
    blocks.extend(
        f"<scope-production-file path={json.dumps(item.path)} "
        f"trust={json.dumps(item.trust)}>\n{item.content}\n"
        "</scope-production-file>"
        for item in composed.files
    )
    if composed.tools:
        blocks.append(
            "<scope-production-tools>\n"
            + json.dumps(
                composed.tools,
                ensure_ascii=False,
                separators=(",", ":"),
            )
            + "\n</scope-production-tools>"
        )
    instructions = "\n\n".join(blocks) + template_note
    return PromptAgentTemplate(
        instructions=instructions,
        tools=[dict(tool) for tool in composed.tools],
        fidelity=fidelity,
        direct_model=direct_model,
    )


def _content_text(content: object) -> str:
    if isinstance(content, str):
        return content
    return json.dumps(content, ensure_ascii=False, separators=(",", ":"))
