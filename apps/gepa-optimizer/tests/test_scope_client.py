# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

import httpx
import pytest

from gepa_optimizer.scope_client import (
    RequestFailedError,
    RequestTimeout,
    ScopeClient,
    SystemicScopeError,
)


def make_client_and_http(handler):
    transport = httpx.MockTransport(handler)
    http = httpx.AsyncClient(transport=transport, base_url="http://test")
    client = ScopeClient(
        "http://test",
        project_id="project-1",
        worker="coder-acp-copilot",
        max_get_retries=2,
    )
    return client, http


async def test_submit_request_builds_body_and_url():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["body"] = request.read().decode()
        return httpx.Response(200, json={"_id": "req-1"})

    client, http = make_client_and_http(handler)
    async with http:
        doc = await client.submit_request(
            http,
            task="do it",
            criteria=["a", "b"],
            agents_md="# guide",
            model="claude-haiku-4.5",
            agents_md_parent_ids=["p1"],
            max_iterations=5,
        )
    assert doc["_id"] == "req-1"
    assert "worker=coder-acp-copilot" in captured["url"]
    assert "projectId=project-1" in captured["url"]
    import json

    body = json.loads(captured["body"])
    assert body["scenario"] == {"task": "do it", "criteria": ["a", "b"]}
    assert body["agentsMd"] == "# guide"
    assert body["model"] == "claude-haiku-4.5"
    assert "experimentId" not in body
    assert body["agentsMdParentIds"] == ["p1"]
    assert body["maxIterations"] == 5


async def test_submit_systemic_on_auth_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="no auth")

    client, http = make_client_and_http(handler)
    async with http:
        with pytest.raises(SystemicScopeError):
            await client.submit_request(http, task="t", criteria=["a"])


async def test_submit_systemic_on_bad_schema():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, text="bad body")

    client, http = make_client_and_http(handler)
    async with http:
        with pytest.raises(SystemicScopeError):
            await client.submit_request(http, task="t", criteria=["a"])


async def test_submit_per_example_on_404():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, text="not found")

    client, http = make_client_and_http(handler)
    async with http:
        with pytest.raises(RequestFailedError):
            await client.submit_request(http, task="t", criteria=["a"])


async def test_get_request_retries_then_succeeds():
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(503, text="busy")
        return httpx.Response(200, json={"_id": "r", "run": {"status": "done"}})

    client, http = make_client_and_http(handler)
    async with http:
        doc = await client.get_request(http, "r")
    assert doc["run"]["status"] == "done"
    assert calls["n"] == 2


async def test_get_request_systemic_after_retries_exhausted():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="busy")

    client, http = make_client_and_http(handler)
    async with http:
        with pytest.raises(SystemicScopeError):
            await client.get_request(http, "r")


async def test_create_empty_experiment_uses_canonical_endpoint_without_retry():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["body"] = request.read().decode()
        return httpx.Response(
            201,
            json={
                "experiment": {
                    "experimentId": "exp-1",
                    "revision": {"experimentRevisionId": "rev-1"},
                },
                "requestIds": [],
            },
        )

    client, http = make_client_and_http(handler)
    async with http:
        payload = await client.create_experiment(
            http, name="GEPA run", description="optimization"
        )

    import json

    assert "projectId=project-1" in captured["url"]
    assert json.loads(captured["body"]) == {
        "mode": "empty",
        "metadata": {"name": "GEPA run", "description": "optimization"},
        "requests": [],
        "requestIds": [],
    }
    assert payload["experiment"]["experimentId"] == "exp-1"


async def test_add_requests_publishes_expected_membership_revision():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["body"] = request.read().decode()
        return httpx.Response(
            201,
            json={
                "experiment": {
                    "experimentId": "exp-1",
                    "revision": {"experimentRevisionId": "rev-2"},
                    "currentExecution": {
                        "experimentExecutionId": "execution-2"
                    },
                },
                "attachedRequestIds": ["req-1"],
                "detachedRequestIds": [],
            },
        )

    client, http = make_client_and_http(handler)
    async with http:
        payload = await client.add_requests(
            http,
            experiment_id="exp-1",
            expected_experiment_revision_id="rev-1",
            request_ids=["req-1"],
        )

    import json

    assert "/api/v1/experiments/exp-1/requests" in captured["url"]
    assert "projectId=project-1" in captured["url"]
    assert json.loads(captured["body"]) == {
        "expectedExperimentRevisionId": "rev-1",
        "requestIds": ["req-1"],
    }
    assert (
        payload["experiment"]["currentExecution"]["experimentExecutionId"]
        == "execution-2"
    )


async def test_experiment_posts_are_not_retried():
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(503, text="busy")

    client, http = make_client_and_http(handler)
    async with http:
        with pytest.raises(SystemicScopeError):
            await client.create_experiment(http, name="GEPA run")
    assert calls["n"] == 1


async def test_wait_for_completion_polls_until_done():
    statuses = ["queued", "processing", "done"]

    def handler(request: httpx.Request) -> httpx.Response:
        s = statuses.pop(0) if statuses else "done"
        return httpx.Response(200, json={"_id": "r", "run": {"status": s}})

    client, http = make_client_and_http(handler)
    async with http:
        doc = await client.wait_for_completion(
            http, "r", timeout_seconds=10, poll_interval_seconds=0
        )
    assert doc["run"]["status"] == "done"


async def test_wait_for_completion_times_out():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"_id": "r", "run": {"status": "processing"}})

    client, http = make_client_and_http(handler)
    async with http:
        with pytest.raises(RequestTimeout):
            await client.wait_for_completion(
                http, "r", timeout_seconds=0, poll_interval_seconds=0
            )


async def test_wait_for_exact_execution_and_list_reports():
    execution_calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/reports"):
            return httpx.Response(
                200,
                json=[{"id": "report-1", "status": "done"}],
            )
        execution_calls["n"] += 1
        readiness = "processing" if execution_calls["n"] == 1 else "done"
        return httpx.Response(
            200,
            json={
                "experimentExecutionId": "execution-2",
                "readiness": readiness,
            },
        )

    client, http = make_client_and_http(handler)
    async with http:
        execution = await client.wait_for_execution(
            http,
            "exp-1",
            "execution-2",
            timeout_seconds=10,
            poll_interval_seconds=0,
        )
        reports = await client.list_execution_reports(
            http, "exp-1", "execution-2"
        )

    assert execution["readiness"] == "done"
    assert reports == [{"id": "report-1", "status": "done"}]
    assert execution_calls["n"] == 2


async def test_get_criterion_returns_none_on_404():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404)

    client, http = make_client_and_http(handler)
    async with http:
        assert await client.get_criterion(http, "missing") is None


async def test_get_criterion_is_project_scoped():
    captured_url = ""

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal captured_url
        captured_url = str(request.url)
        return httpx.Response(200, json={"id": "criterion-1"})

    client, http = make_client_and_http(handler)
    async with http:
        await client.get_criterion(http, "criterion-1")

    assert "projectId=project-1" in captured_url


async def test_get_criterion_retries_idempotent_read():
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(503, text="busy")
        return httpx.Response(200, json={"id": "criterion-1"})

    client, http = make_client_and_http(handler)
    async with http:
        criterion = await client.get_criterion(http, "criterion-1")

    assert criterion == {"id": "criterion-1"}
    assert calls["n"] == 2
