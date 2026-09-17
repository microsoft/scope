"""Command-line entry point for Scope prompt evaluations."""

from __future__ import annotations

import argparse
import asyncio
import inspect
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Awaitable, Callable

from .artifacts import create_run_directory, redact_error, relative_artifacts, write_json
from .config import RunConfig

TrackRunner = Callable[[RunConfig, Path], dict[str, Any] | Awaitable[dict[str, Any]]]


def parse_args() -> argparse.Namespace:
    package_root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--mode",
        choices=("quality", "red-team", "both"),
        default="both",
    )
    parser.add_argument("--samples", type=int, default=3)
    parser.add_argument("--smoke", action="store_true")
    parser.add_argument("--source-run", type=Path, help="Reuse this run's exact cases and responses; never generate")
    parser.add_argument("--regrade", action="append", default=[], metavar="FAMILY/EVALUATOR",
                        help="Explicitly rerun an affected grader; repeat for multiple graders")
    parser.add_argument(
        "--offline",
        action="store_true",
        help="Use the fake generator and skip Azure-assisted graders",
    )
    parser.add_argument(
        "--results-dir",
        type=Path,
        default=package_root / "results",
    )
    parser.add_argument(
        "--dataset",
        type=Path,
        default=package_root / "datasets" / "manifest.json",
    )
    parser.add_argument(
        "--surface-profiles",
        type=Path,
        default=package_root / "red-team" / "surface-profiles.yaml",
    )
    parser.add_argument(
        "--red-team-config",
        type=Path,
        default=package_root / "red-team" / "red-team.yaml",
    )
    return parser.parse_args([argument for argument in sys.argv[1:] if argument != "--"])


async def invoke_runner(
    runner: TrackRunner,
    config: RunConfig,
    track_dir: Path,
) -> dict[str, Any]:
    result = runner(config, track_dir)
    if inspect.isawaitable(result):
        return await result
    return result


async def run_track(
    name: str,
    runner: TrackRunner,
    config: RunConfig,
    run_dir: Path,
) -> dict[str, Any]:
    track_dir = run_dir / name
    track_dir.mkdir(parents=True, exist_ok=True)
    started_at = datetime.now(UTC).isoformat()
    try:
        summary = await invoke_runner(runner, config, track_dir)
        status = str(summary.get("status", "succeeded"))
        return {
            "status": status,
            "startedAt": started_at,
            "completedAt": datetime.now(UTC).isoformat(),
            "summary": summary,
            "artifacts": relative_artifacts(run_dir, track_dir),
        }
    except Exception as error:
        return {
            "status": "infrastructure-failed",
            "startedAt": started_at,
            "completedAt": datetime.now(UTC).isoformat(),
            "error": redact_error(error),
            "artifacts": relative_artifacts(run_dir, track_dir),
        }


async def run() -> int:
    args = parse_args()
    if args.samples < 1:
        raise ValueError("--samples must be at least 1")
    if args.source_run and (args.mode != "quality" or args.smoke):
        raise ValueError("--source-run requires --mode quality and cannot use --smoke")
    if args.regrade and (not args.source_run or args.offline):
        raise ValueError("--regrade requires --source-run without --offline")
    source_run = args.source_run.resolve() if args.source_run else None
    results_dir = args.results_dir.resolve()
    if source_run is not None and results_dir.is_relative_to(source_run):
        raise ValueError("--results-dir must not be inside or equal to --source-run")

    package_root = Path(__file__).resolve().parents[2]
    repo_root = package_root.parents[1]
    run_id, run_dir = create_run_directory(results_dir)
    manifest_path = run_dir / "manifest.json"
    config = RunConfig(
        package_root=package_root,
        repo_root=repo_root,
        run_dir=run_dir,
        manifest_path=package_root / "evaluation-manifest.yaml",
        dataset_path=args.dataset.resolve(),
        surface_profiles_path=args.surface_profiles.resolve(),
        red_team_config_path=args.red_team_config.resolve(),
        samples=args.samples,
        smoke=args.smoke,
        offline=args.offline,
        source_run=source_run,
        regrade=tuple(args.regrade),
    )
    manifest: dict[str, Any] = {
        "schemaVersion": 1,
        "runId": run_id,
        "mode": args.mode,
        "status": "running",
        "startedAt": datetime.now(UTC).isoformat(),
        "tracks": {},
    }
    write_json(manifest_path, manifest)

    if args.mode in ("quality", "both"):
        from .quality import run_quality

        manifest["tracks"]["quality"] = await run_track(
            "quality", run_quality, config, run_dir
        )
        write_json(manifest_path, manifest)

    if args.mode in ("red-team", "both"):
        from .red_team import run_red_team

        manifest["tracks"]["red-team"] = await run_track(
            "red-team", run_red_team, config, run_dir
        )
        write_json(manifest_path, manifest)

    statuses = {
        str(track["status"]) for track in manifest["tracks"].values()
    }
    manifest["completedAt"] = datetime.now(UTC).isoformat()
    manifest["status"] = "succeeded" if statuses == {"succeeded"} else "failed"
    write_json(manifest_path, manifest)
    print(run_dir)
    return 0 if manifest["status"] == "succeeded" else 1


def main() -> None:
    try:
        raise SystemExit(asyncio.run(run()))
    except KeyboardInterrupt:
        raise SystemExit(130) from None


if __name__ == "__main__":
    main()
