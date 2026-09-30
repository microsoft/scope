import json
import sys
from pathlib import Path
from types import ModuleType

import pytest

from static_prompt_evals import cli
from static_prompt_evals.quality.replay import file_hashes


@pytest.mark.asyncio
@pytest.mark.parametrize("arguments,message", [
    (["--mode", "quality", "--source-run", "source", "--smoke"], "cannot use --smoke"),
    (["--mode", "quality", "--regrade", "family/evaluator"], "requires --source-run"),
    (["--mode", "quality", "--source-run", "source", "--offline", "--regrade", "family/evaluator"], "without --offline"),
])
async def test_invalid_replay_scope_fails_before_creating_run(monkeypatch, arguments, message):
    monkeypatch.setattr(sys, "argv", ["scope-evals", *arguments])
    with pytest.raises(ValueError, match=message):
        await cli.run()


@pytest.mark.asyncio
@pytest.mark.parametrize("overlap", ["equal", "child", "results-symlink", "child-through-symlink", "source-symlink"])
async def test_source_overlap_rejected_before_any_filesystem_write(tmp_path, monkeypatch, overlap):
    source = tmp_path / "source"
    (source / "quality").mkdir(parents=True)
    (source / "manifest.json").write_text('{"runId":"immutable"}\n')
    (source / "quality/production-rows.jsonl").write_text('{"original":"response"}\n')
    source_arg = source
    results = source if overlap == "equal" else source / "new-results"
    if overlap in {"results-symlink", "child-through-symlink"}:
        alias = tmp_path / "results-alias"
        alias.symlink_to(source, target_is_directory=True)
        results = alias if overlap == "results-symlink" else alias / "new-results"
    elif overlap == "source-symlink":
        source_arg = tmp_path / "source-alias"
        source_arg.symlink_to(source, target_is_directory=True)
    hashes_before = file_hashes(source)
    entries_before = {p.relative_to(tmp_path) for p in tmp_path.rglob("*")}
    monkeypatch.setattr(sys, "argv", [
        "scope-evals", "--mode", "quality", "--offline",
        "--source-run", str(source_arg), "--results-dir", str(results),
    ])
    with pytest.raises(ValueError, match="must not be inside or equal"):
        await cli.run()
    assert file_hashes(source) == hashes_before
    assert {p.relative_to(tmp_path) for p in tmp_path.rglob("*")} == entries_before


@pytest.mark.asyncio
async def test_source_and_new_run_can_share_results_parent(tmp_path, monkeypatch):
    source = tmp_path / "source"
    source.mkdir()
    (source / "manifest.json").write_text('{"runId":"immutable"}\n')
    before = file_hashes(source)
    quality = ModuleType("static_prompt_evals.quality")
    quality.run_quality = lambda config, track: {"status": "succeeded"}
    monkeypatch.setitem(sys.modules, "static_prompt_evals.quality", quality)
    monkeypatch.setattr(sys, "argv", [
        "scope-evals", "--mode", "quality", "--offline",
        "--source-run", str(source), "--results-dir", str(tmp_path),
    ])
    assert await cli.run() == 0
    assert file_hashes(source) == before
    assert len(list(tmp_path.iterdir())) == 2


@pytest.mark.asyncio
async def test_default_mode_runs_only_quality(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    quality = ModuleType("static_prompt_evals.quality")

    def run_quality(config: object, run_dir: Path) -> dict[str, object]:
        (run_dir / "rows.jsonl").write_text('{"status":"ok"}\n', encoding="utf-8")
        return {"status": "succeeded"}

    quality.run_quality = run_quality  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "static_prompt_evals.quality", quality)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "scope-evals",
            "--",
            "--results-dir",
            str(tmp_path),
        ],
    )

    assert await cli.run() == 0

    run_dirs = list(tmp_path.iterdir())
    assert len(run_dirs) == 1
    manifest = json.loads(
        (run_dirs[0] / "manifest.json").read_text(encoding="utf-8")
    )
    assert manifest["status"] == "succeeded"
    assert manifest["tracks"]["quality"]["artifacts"] == ["quality/rows.jsonl"]
    assert manifest["mode"] == "quality"
    assert set(manifest["tracks"]) == {"quality"}


@pytest.mark.asyncio
async def test_quality_failure_retains_redacted_error(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    quality = ModuleType("static_prompt_evals.quality")

    def run_quality(config: object, run_dir: Path) -> dict[str, object]:
        raise RuntimeError("https://secret.example/token-abcdefghijklmnopqrstuvwxyz")

    quality.run_quality = run_quality  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "static_prompt_evals.quality", quality)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "scope-evals",
            "--mode",
            "quality",
            "--results-dir",
            str(tmp_path),
        ],
    )

    assert await cli.run() == 1

    manifest = json.loads(
        (next(tmp_path.iterdir()) / "manifest.json").read_text(encoding="utf-8")
    )
    assert manifest["tracks"]["quality"]["status"] == "infrastructure-failed"
    assert "secret.example" not in manifest["tracks"]["quality"]["error"]
    assert set(manifest["tracks"]) == {"quality"}


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["red-team", "both"])
async def test_removed_modes_fail_before_creating_a_run(monkeypatch, tmp_path, mode):
    monkeypatch.setattr(sys, "argv", [
        "scope-evals", "--mode", mode, "--results-dir", str(tmp_path),
    ])
    with pytest.raises(SystemExit) as error:
        await cli.run()
    assert error.value.code == 2
    assert list(tmp_path.iterdir()) == []
