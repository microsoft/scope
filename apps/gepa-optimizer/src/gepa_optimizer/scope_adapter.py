# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""``ScopeAdapter`` — a GEPA adapter that scores AGENTS.md candidates with Scope.

Each GEPA candidate is ``{"AGENTS.md": "<text>"}``. ``evaluate`` submits one
standalone Scope run per dataset example, publishes those requests as one
canonical Experiment membership revision, polls the exact requests and
execution, and scores from persisted criteria results. Submissions/polls run
concurrently under a semaphore capped at the Linux ``coder-acp-copilot`` KEDA
ceiling (default 10).

Failure model (per the rubber-duck critique):

* A *per-example* failure (HTTP transport error, run timeout, a single rejected
  submission) yields a ``0.0`` score with an error trajectory — GEPA keeps going.
* A *systemic* failure (auth, bad schema, repeated 5xx) raised by the client
  aborts the batch if it affects a majority of examples, so we never optimize
  toward infrastructure noise.
"""

from __future__ import annotations

import asyncio
from typing import Any, Mapping, Sequence

import httpx
from gepa.core.adapter import EvaluationBatch, GEPAAdapter

from .reflective import build_reflective_record
from .scope_client import (
    RequestFailedError,
    RequestTimeout,
    ScopeClient,
    SystemicScopeError,
)
from .scoring import compute_run_score

COMPONENT = "AGENTS.md"


class ScopeAdapter(GEPAAdapter):
    def __init__(
        self,
        client: ScopeClient,
        *,
        model: str,
        experiment_id: str,
        experiment_revision_id: str,
        max_iterations: int,
        max_concurrency: int = 10,
        run_timeout_seconds: float = 1800.0,
        poll_interval_seconds: float = 15.0,
        score_strategy: str = "mean",
        reflective_max_chars: int | None = None,
    ) -> None:
        self.client = client
        self.model = model
        self.experiment_id = experiment_id
        self.experiment_revision_id = experiment_revision_id
        self.max_iterations = max_iterations
        self.max_concurrency = max_concurrency
        self.run_timeout_seconds = run_timeout_seconds
        self.poll_interval_seconds = poll_interval_seconds
        self.score_strategy = score_strategy
        self.reflective_max_chars = reflective_max_chars

    # -- GEPAAdapter.evaluate ---------------------------------------------

    def evaluate(
        self,
        batch: Sequence[Mapping[str, Any]],
        candidate: Mapping[str, str],
        capture_traces: bool = False,
    ) -> EvaluationBatch:
        agents_md = candidate.get(COMPONENT, "")
        results = asyncio.run(self._evaluate_async(batch, agents_md))

        # Abort only if a *majority* of examples hit systemic failures — a few
        # transient per-example errors should not poison the run.
        systemic = [r for r in results if isinstance(r.get("error_kind"), str) and r["error_kind"] == "systemic"]
        if batch and len(systemic) > len(batch) / 2:
            raise SystemicScopeError(
                f"{len(systemic)}/{len(batch)} evaluations failed systemically; "
                "aborting to avoid optimizing toward infrastructure failure."
            )

        outputs = [r["output"] for r in results]
        scores = [r["score"] for r in results]
        trajectories = [r["trajectory"] for r in results] if capture_traces else None
        return EvaluationBatch(outputs=outputs, scores=scores, trajectories=trajectories)

    async def _evaluate_async(
        self, batch: Sequence[Mapping[str, Any]], agents_md: str
    ) -> list[dict[str, Any]]:
        sem = asyncio.Semaphore(self.max_concurrency)
        async with httpx.AsyncClient(timeout=self.client.timeout_seconds) as http:
            async def submit_one(example: Mapping[str, Any]) -> dict[str, Any]:
                async with sem:
                    return await self._submit_one(http, example, agents_md)

            submitted = await asyncio.gather(*(submit_one(ex) for ex in batch))
            request_ids = [
                result["request_id"]
                for result in submitted
                if result.get("request_id") is not None
            ]
            if not request_ids:
                return submitted

            membership = await self.client.add_requests(
                http,
                experiment_id=self.experiment_id,
                expected_experiment_revision_id=self.experiment_revision_id,
                request_ids=request_ids,
            )
            experiment = membership.get("experiment") or {}
            revision = experiment.get("revision") or {}
            execution = experiment.get("currentExecution") or {}
            revision_id = revision.get("experimentRevisionId")
            execution_id = execution.get("experimentExecutionId")
            if not isinstance(revision_id, str) or not isinstance(execution_id, str):
                raise SystemicScopeError(
                    "Experiment membership response omitted revision/execution identity"
                )
            self.experiment_revision_id = revision_id

            async def finish_one(result: dict[str, Any]) -> dict[str, Any]:
                if result.get("request_id") is None:
                    return result
                async with sem:
                    return await self._finish_one(
                        http,
                        result,
                        revision_id=revision_id,
                        execution_id=execution_id,
                    )

            results = await asyncio.gather(*(finish_one(result) for result in submitted))
            execution_error = None
            try:
                exact_execution = await self.client.wait_for_execution(
                    http,
                    self.experiment_id,
                    execution_id,
                    timeout_seconds=self.run_timeout_seconds,
                    poll_interval_seconds=self.poll_interval_seconds,
                )
            except RequestTimeout as exc:
                execution_error = str(exc)
                exact_execution = await self.client.get_execution(
                    http, self.experiment_id, execution_id
                )
            reports = await self.client.list_execution_reports(
                http, self.experiment_id, execution_id
            )
            report_refs = [
                {
                    "reportId": report.get("id") or report.get("_id"),
                    "status": report.get("status"),
                    "reportType": report.get("reportType"),
                }
                for report in reports
            ]
            for result in results:
                result["output"].update(
                    {
                        "experimentId": self.experiment_id,
                        "experimentRevisionId": revision_id,
                        "experimentExecutionId": execution_id,
                        "experimentReadiness": exact_execution.get("readiness"),
                        "reports": report_refs,
                        **(
                            {"experimentExecutionError": execution_error}
                            if execution_error
                            else {}
                        ),
                    }
                )
                result["trajectory"].update(result["output"])
            return results

    async def _submit_one(
        self,
        http: httpx.AsyncClient,
        example: Mapping[str, Any],
        agents_md: str,
    ) -> dict[str, Any]:
        task = example.get("task", "")
        criteria = list(example.get("criteria") or [])
        try:
            created = await self.client.submit_request(
                http,
                task=task,
                criteria=criteria,
                agents_md=agents_md or None,
                model=self.model,
                max_iterations=self.max_iterations,
            )
            request_id = created.get("_id") or created.get("id")
            if not isinstance(request_id, str):
                raise SystemicScopeError("Request submission omitted request identity")
            return {
                "request_id": request_id,
                "task": task,
                "criteria": criteria,
            }
        except SystemicScopeError as exc:
            return self._failure(task, criteria, str(exc), "systemic")
        except (RequestFailedError, RequestTimeout) as exc:
            return self._failure(task, criteria, str(exc), "per_example")
        except Exception as exc:  # never raise for a single example
            return self._failure(task, criteria, repr(exc), "per_example")

    async def _finish_one(
        self,
        http: httpx.AsyncClient,
        submitted: Mapping[str, Any],
        *,
        revision_id: str,
        execution_id: str,
    ) -> dict[str, Any]:
        task = str(submitted["task"])
        criteria = list(submitted["criteria"])
        request_id = str(submitted["request_id"])
        try:
            doc = await self.client.wait_for_completion(
                http,
                request_id,
                timeout_seconds=self.run_timeout_seconds,
                poll_interval_seconds=self.poll_interval_seconds,
            )
            run = doc.get("run") or {}
            score = compute_run_score(run, criteria, self.score_strategy)
            trajectory = self._build_trajectory(
                task, criteria, request_id, run, score
            )
            identity = {
                "requestId": request_id,
                "score": score,
                "experimentId": self.experiment_id,
                "experimentRevisionId": revision_id,
                "experimentExecutionId": execution_id,
            }
            return {
                "score": score,
                "output": identity,
                "trajectory": {**trajectory, **identity},
                "error_kind": None,
            }
        except SystemicScopeError as exc:
            return self._failure(task, criteria, str(exc), "systemic")
        except (RequestFailedError, RequestTimeout) as exc:
            return self._failure(task, criteria, str(exc), "per_example")
        except Exception as exc:  # never raise for a single example
            return self._failure(task, criteria, repr(exc), "per_example")

    def _build_trajectory(
        self,
        task: str,
        criteria: Sequence[str],
        request_id: str | None,
        run: Mapping[str, Any],
        score: float,
    ) -> dict[str, Any]:
        turns_out = []
        for t in run.get("turns") or []:
            turns_out.append(
                {
                    "iteration": t.get("iteration"),
                    "response": t.get("codingAgentResponse"),
                    "judgeFeedback": t.get("judgeFeedback"),
                    "criteriaResults": t.get("criteriaResults") or [],
                }
            )
        return {
            "task": task,
            "criteria": list(criteria),
            "requestId": request_id,
            "runOutcome": run.get("outcome"),
            "turns": turns_out,
            "score": score,
        }

    def _failure(
        self, task: str, criteria: Sequence[str], message: str, kind: str
    ) -> dict[str, Any]:
        trajectory = {
            "task": task,
            "criteria": list(criteria),
            "requestId": None,
            "runOutcome": None,
            "turns": [],
            "score": 0.0,
            "error": message,
        }
        return {
            "request_id": None,
            "score": 0.0,
            "output": {"error": message},
            "trajectory": trajectory,
            "error_kind": kind,
        }

    # -- GEPAAdapter.make_reflective_dataset ------------------------------

    def make_reflective_dataset(
        self,
        candidate: Mapping[str, str],
        eval_batch: EvaluationBatch,
        components_to_update: Sequence[str],
    ) -> Mapping[str, Sequence[Mapping[str, Any]]]:
        trajectories = eval_batch.trajectories or []
        records = [
            build_reflective_record(
                traj,
                traj.get("criteria") or [],
                max_chars=self.reflective_max_chars,
            )
            for traj in trajectories
        ]
        # We only ever optimize the single AGENTS.md component.
        return {component: records for component in components_to_update}
