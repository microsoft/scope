# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""Async REST client for the Scope API used by the GEPA adapter.

Only the handful of endpoints the optimizer needs are implemented:

* ``create_experiment`` — POST one canonical empty Experiment.
* ``add_requests`` — publish a membership revision for evaluated requests.
* ``submit_request`` — POST a standalone request (task + criteria + AGENTS.md).
* ``get_request`` — GET a request doc (including its ``run`` state).
* ``wait_for_completion`` — poll ``get_request`` until ``run.status == "done"``.
* ``wait_for_execution`` — poll one exact Experiment execution.
* ``list_execution_reports`` — read reports for that exact execution.
* ``get_criterion`` — used for preflight validation of criterion ids.

Error model (see the rubber-duck critique): a ``SystemicScopeError`` signals a
problem that would poison the whole optimization (auth failure, malformed
request schema, repeated 5xx) and should abort the run. A ``RequestFailedError``
or ``RequestTimeout`` is a *per-example* failure that the adapter turns into a
``0.0`` score without aborting. Idempotent GETs are retried with exponential
backoff + jitter; POSTs are **not** retried (a duplicate POST would launch a
second real agent run).
"""

from __future__ import annotations

import asyncio
import random
from typing import Any, Mapping, Sequence

import httpx

DONE_STATUS = "done"
TERMINAL_EXECUTION_READINESS = {"blocked", "done", "failed"}


class ScopeError(Exception):
    """Base class for Scope client errors."""


class SystemicScopeError(ScopeError):
    """A failure that should abort the whole optimization (auth, schema, 5xx)."""


class RequestFailedError(ScopeError):
    """A single submission failed in a way that is local to that example."""


class RequestTimeout(ScopeError):
    """A run did not reach a terminal state within the timeout."""


def _is_systemic_status(status: int) -> bool:
    # 401/403 = auth; 400/422 = our payload is wrong; 5xx after retries = infra.
    return status in (400, 401, 403, 422) or status >= 500


class ScopeClient:
    def __init__(
        self,
        base_url: str,
        *,
        project_id: str,
        worker: str = "coder-acp-copilot",
        timeout_seconds: float = 30.0,
        max_get_retries: int = 4,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.project_id = project_id
        self.worker = worker
        self.timeout_seconds = timeout_seconds
        self.max_get_retries = max_get_retries

    # -- low-level helpers -------------------------------------------------

    async def _get_json(
        self,
        client: httpx.AsyncClient,
        path: str,
        *,
        allow_not_found: bool = False,
    ) -> Any:
        """GET with retry/backoff on 429/5xx/network errors."""
        last_exc: Exception | None = None
        for attempt in range(self.max_get_retries):
            try:
                resp = await client.get(f"{self.base_url}{path}")
                if allow_not_found and resp.status_code == 404:
                    return None
                if resp.status_code == 429 or resp.status_code >= 500:
                    last_exc = SystemicScopeError(
                        f"GET {path} -> {resp.status_code}"
                    )
                elif resp.status_code >= 400:
                    raise SystemicScopeError(
                        f"GET {path} -> {resp.status_code}: {resp.text[:500]}"
                    )
                else:
                    return resp.json()
            except (httpx.TransportError, httpx.TimeoutException) as exc:
                last_exc = exc
            if attempt + 1 < self.max_get_retries:
                await asyncio.sleep(
                    min(2**attempt, 10) * (0.5 + random.random())
                )
        raise SystemicScopeError(f"GET {path} failed after retries: {last_exc}")

    # -- public API --------------------------------------------------------

    async def submit_request(
        self,
        client: httpx.AsyncClient,
        *,
        task: str,
        criteria: Sequence[str],
        agents_md: str | None = None,
        model: str | None = None,
        agents_md_parent_ids: Sequence[str] | None = None,
        max_iterations: int | None = None,
    ) -> Mapping[str, Any]:
        """Submit one request. Returns the created request doc (with ``_id``)."""
        body: dict[str, Any] = {"scenario": {"task": task, "criteria": list(criteria)}}
        if model:
            body["model"] = model
        if max_iterations:
            body["maxIterations"] = max_iterations
        if agents_md:
            body["agentsMd"] = agents_md
        if agents_md_parent_ids:
            body["agentsMdParentIds"] = list(agents_md_parent_ids)

        url = f"{self.base_url}/api/v1/requests"
        try:
            resp = await client.post(
                url,
                params={"worker": self.worker, "projectId": self.project_id},
                json=body,
            )
        except (httpx.TransportError, httpx.TimeoutException) as exc:
            # The outcome is ambiguous, so never retry and risk a duplicate run.
            raise RequestFailedError(f"POST /requests transport error: {exc}") from exc

        if resp.status_code >= 400:
            text = resp.text[:500]
            if _is_systemic_status(resp.status_code):
                raise SystemicScopeError(
                    f"POST /requests -> {resp.status_code}: {text}"
                )
            raise RequestFailedError(f"POST /requests -> {resp.status_code}: {text}")
        return resp.json()

    async def create_experiment(
        self,
        client: httpx.AsyncClient,
        *,
        name: str,
        description: str | None = None,
    ) -> Mapping[str, Any]:
        """Create one empty canonical Experiment. This POST is never retried."""
        metadata = {"name": name}
        if description:
            metadata["description"] = description
        return await self._systemic_post_json(
            client,
            "/api/v1/experiments",
            {
                "mode": "empty",
                "metadata": metadata,
                "requests": [],
                "requestIds": [],
            },
        )

    async def add_requests(
        self,
        client: httpx.AsyncClient,
        *,
        experiment_id: str,
        expected_experiment_revision_id: str,
        request_ids: Sequence[str],
    ) -> Mapping[str, Any]:
        """Publish one canonical membership revision. This POST is never retried."""
        return await self._systemic_post_json(
            client,
            f"/api/v1/experiments/{experiment_id}/requests",
            {
                "expectedExperimentRevisionId": expected_experiment_revision_id,
                "requestIds": list(request_ids),
            },
        )

    async def _systemic_post_json(
        self,
        client: httpx.AsyncClient,
        path: str,
        body: Mapping[str, Any],
    ) -> Mapping[str, Any]:
        try:
            resp = await client.post(
                f"{self.base_url}{path}",
                params={"projectId": self.project_id},
                json=body,
            )
        except (httpx.TransportError, httpx.TimeoutException) as exc:
            raise SystemicScopeError(f"POST {path} transport error: {exc}") from exc
        if resp.status_code >= 400:
            raise SystemicScopeError(
                f"POST {path} -> {resp.status_code}: {resp.text[:500]}"
            )
        payload = resp.json()
        if not isinstance(payload, Mapping):
            raise SystemicScopeError(f"POST {path} returned a non-object response")
        return payload

    async def get_request(
        self, client: httpx.AsyncClient, request_id: str
    ) -> Mapping[str, Any]:
        return await self._get_json(client, f"/api/v1/requests/{request_id}")

    async def get_experiment(
        self, client: httpx.AsyncClient, experiment_id: str
    ) -> Mapping[str, Any]:
        return await self._get_json(
            client,
            f"/api/v1/experiments/{experiment_id}?projectId={self.project_id}",
        )

    async def get_execution(
        self,
        client: httpx.AsyncClient,
        experiment_id: str,
        experiment_execution_id: str,
    ) -> Mapping[str, Any]:
        return await self._get_json(
            client,
            f"/api/v1/experiments/{experiment_id}/executions/"
            f"{experiment_execution_id}?projectId={self.project_id}",
        )

    async def list_execution_reports(
        self,
        client: httpx.AsyncClient,
        experiment_id: str,
        experiment_execution_id: str,
    ) -> Sequence[Mapping[str, Any]]:
        payload = await self._get_json(
            client,
            f"/api/v1/experiments/{experiment_id}/executions/"
            f"{experiment_execution_id}/reports?projectId={self.project_id}",
        )
        if not isinstance(payload, list):
            raise SystemicScopeError("Experiment reports response was not an array")
        return payload

    async def get_criterion(
        self, client: httpx.AsyncClient, criterion_id: str
    ) -> Mapping[str, Any] | None:
        """Return the criterion doc, or ``None`` if it does not exist (404)."""
        return await self._get_json(
            client,
            f"/api/v1/criteria/{criterion_id}?projectId={self.project_id}",
            allow_not_found=True,
        )

    async def wait_for_completion(
        self,
        client: httpx.AsyncClient,
        request_id: str,
        *,
        timeout_seconds: float,
        poll_interval_seconds: float,
    ) -> Mapping[str, Any]:
        """Poll until ``run.status == "done"``; raise ``RequestTimeout`` if not."""
        loop = asyncio.get_event_loop()
        deadline = loop.time() + timeout_seconds
        while True:
            doc = await self.get_request(client, request_id)
            run = doc.get("run") or {}
            if run.get("status") == DONE_STATUS:
                return doc
            if loop.time() >= deadline:
                raise RequestTimeout(
                    f"request {request_id} not done within {timeout_seconds}s "
                    f"(last status={run.get('status')})"
                )
            await asyncio.sleep(poll_interval_seconds)

    async def wait_for_execution(
        self,
        client: httpx.AsyncClient,
        experiment_id: str,
        experiment_execution_id: str,
        *,
        timeout_seconds: float,
        poll_interval_seconds: float,
    ) -> Mapping[str, Any]:
        """Poll one exact execution until its handlers finish or fail."""
        loop = asyncio.get_event_loop()
        deadline = loop.time() + timeout_seconds
        while True:
            execution = await self.get_execution(
                client, experiment_id, experiment_execution_id
            )
            readiness = execution.get("readiness")
            if readiness in TERMINAL_EXECUTION_READINESS:
                return execution
            if loop.time() >= deadline:
                raise RequestTimeout(
                    f"experiment execution {experiment_execution_id} did not finish "
                    f"within {timeout_seconds}s (last readiness={readiness})"
                )
            await asyncio.sleep(poll_interval_seconds)
