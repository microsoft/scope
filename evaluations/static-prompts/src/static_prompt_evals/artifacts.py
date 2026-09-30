"""Run-directory and manifest helpers."""

from __future__ import annotations

import json
import re
import secrets
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

_URL_PATTERN = re.compile(r"https?://[^\s\"']+")
_GUID_PATTERN = re.compile(
    r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"
)
_TOKEN_PATTERN = re.compile(r"\b[A-Za-z0-9_-]{32,}\b")


def create_run_directory(results_root: Path) -> tuple[str, Path]:
    run_id = f"{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}-{secrets.token_hex(4)}"
    run_dir = results_root / run_id
    run_dir.mkdir(parents=True, exist_ok=False)
    return run_id, run_dir


def redact_error(error: BaseException) -> str:
    message = f"{type(error).__name__}: {error}"
    message = _URL_PATTERN.sub("[redacted-url]", message)
    message = _GUID_PATTERN.sub("[redacted-id]", message)
    return _TOKEN_PATTERN.sub("[redacted-token]", message)


def relative_artifacts(run_dir: Path, track_dir: Path) -> list[str]:
    if not track_dir.exists():
        return []
    return sorted(
        str(path.relative_to(run_dir))
        for path in track_dir.rglob("*")
        if path.is_file()
    )


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)
