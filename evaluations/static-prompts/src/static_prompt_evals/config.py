"""Shared configuration passed to quality and red-team runners."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class RunConfig:
    package_root: Path
    repo_root: Path
    run_dir: Path
    manifest_path: Path
    dataset_path: Path
    surface_profiles_path: Path
    red_team_config_path: Path
    samples: int
    smoke: bool
    offline: bool = False
    source_run: Path | None = None
    regrade: tuple[str, ...] = ()
