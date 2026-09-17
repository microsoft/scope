"""YAML configuration loading for cloud red-team runs."""

from __future__ import annotations

from pathlib import Path
from typing import Any, TypeVar

import yaml
from pydantic import BaseModel

from .models import RedTeamSettings, SurfaceProfiles

ModelT = TypeVar("ModelT", bound=BaseModel)


def _load_yaml(path: Path, model: type[ModelT]) -> ModelT:
    with path.open(encoding="utf-8") as handle:
        value: Any = yaml.safe_load(handle)
    return model.model_validate(value)


def load_surface_profiles(path: Path) -> SurfaceProfiles:
    return _load_yaml(path, SurfaceProfiles)

def load_red_team_settings(path: Path) -> RedTeamSettings:
    return _load_yaml(path, RedTeamSettings)
    return _load_yaml(path, RedTeamSettings)
