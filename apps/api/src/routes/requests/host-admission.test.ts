// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import type { ProfileDocument, ProfileVersionDocument } from "shared";
import type {
  CodingAgentDocument,
  RequestDocument,
  RouteContext,
  RunHistoryDocument,
  WorkerType,
} from "../../route-context.js";
import { createMockCollection } from "../../test-helpers.js";
import { registerRequestsRoutes } from "./index.js";

const PROJECT_ID = "admission-project";
const HOSTS = ["coder-acp-copilot-host", "coder-acp-claude-code-host"] as const;
const DOCKER = "coder-acp-copilot";
const SUBMIT = { scenario: { task: "Write hello.js", criteria: [] }, maxIterations: 1 };

function makeRequest(workerType: WorkerType, overrides: Partial<RequestDocument> = {}): RequestDocument {
  return {
    _id: "original",
    projectId: PROJECT_ID,
    workerType,
    scenario: SUBMIT.scenario,
    maxIterations: 1,
    priority: 0,
    createdAt: new Date(),
    run: { _id: "attempt-1", attemptNumber: 1, status: "done", outcome: "failed" },
    ...overrides,
  };
}

function makeAgent(worker: WorkerType, available?: boolean): CodingAgentDocument {
  return {
    _id: worker,
    name: worker,
    available,
    supportedModels: ["test-model"],
    defaultModel: "test-model",
    createdAt: new Date(),
    versions: [{
      agentVersion: "test-v1",
      workerVersion: "test",
      components: {},
      gitCommit: "test",
      buildTime: "test",
      imageTag: "test",
      queueName: `queue-${worker}`,
      status: "active",
      createdAt: new Date(),
    }],
  };
}

function makeProfileVersion(profileId: string, workerType: WorkerType, version = 1): ProfileVersionDocument {
  return {
    _id: `${profileId}-version-${version}`,
    ref: `${profileId}@${version}`,
    projectId: PROJECT_ID,
    profileId,
    version,
    workerType,
    model: "test-model",
    createdAt: new Date(),
  };
}

function harness(
  docs: RequestDocument[] = [],
  agents: CodingAgentDocument[] = [],
  versions: ProfileVersionDocument[] = [],
) {
  const app = express();
  app.use(express.json());
  const requestCollection = createMockCollection<RequestDocument>(docs);
  const runsCollection = createMockCollection<RunHistoryDocument>();
  const agentCollection = createMockCollection<CodingAgentDocument>();
  vi.mocked(agentCollection.findOne).mockImplementation(async (filter) =>
    agents.find((agent) => agent._id === filter._id && !agent.deletedAt) ?? null,
  );
  const profileCollection = createMockCollection<ProfileDocument>();
  vi.mocked(profileCollection.findOne).mockImplementation(async (filter) => {
    const matches = versions.filter((version) => version.profileId === filter._id);
    return matches.length ? {
      _id: matches[0].profileId,
      projectId: PROJECT_ID,
      name: matches[0].profileId,
      latestVersion: Math.max(...matches.map((version) => version.version)),
      createdAt: new Date(),
    } : null;
  });
  const profileVersionCollection = createMockCollection<ProfileVersionDocument>();
  vi.mocked(profileVersionCollection.findOne).mockImplementation(async (filter) =>
    versions.find((version) =>
      filter.$or
        ? filter.projectId === version.projectId
          && filter.$or.some((clause) => clause.ref === version.ref || clause._id === version._id)
        : filter.profileId === version.profileId && filter.version === version.version,
    ) ?? null,
  );
  const taskPromptStore = {
    findOrCreate: vi.fn().mockResolvedValue({ _id: "task-prompt" }),
  };
  registerRequestsRoutes({
    app,
    registry: new OpenAPIRegistry(),
    requestCollection,
    runsCollection,
    agentCollection,
    profileCollection,
    profileVersionCollection,
    taskPromptStore,
    blobStorage: { getLogsBlobUrl: (path: string) => `https://blobs.invalid/${path}` },
  } as unknown as RouteContext);
  return { app, requestCollection, runsCollection, agentCollection, profileVersionCollection };
}

function expectNoWorkWrites(ctx: ReturnType<typeof harness>) {
  expect(ctx.requestCollection.insertOne).not.toHaveBeenCalled();
  expect(ctx.requestCollection.insertMany).not.toHaveBeenCalled();
  expect(ctx.requestCollection.updateOne).not.toHaveBeenCalled();
  expect(ctx.requestCollection.updateMany).not.toHaveBeenCalled();
  expect(ctx.runsCollection.insertOne).not.toHaveBeenCalled();
}

describe.each(HOSTS)("host admission for %s", (host) => {
  it.each(["missing", "disabled", "unspecified", "deleted"] as const)(
    "rejects resubmitting an original host with %s availability before any inserts",
    async (availability) => {
      const agent = makeAgent(host, availability === "deleted" ? true : availability === "disabled" ? false : undefined);
      if (availability === "deleted") agent.deletedAt = new Date();
      const ctx = harness(
        [makeRequest(DOCKER, { _id: "docker" }), makeRequest(host)],
        availability === "missing" ? [] : [agent],
      );

      const res = await request(ctx.app).post("/api/v1/requests/bulk-resubmit")
        .send({ ids: ["docker", "original"], count: 2 });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: `Worker "${host}" is not available for new submissions` });
      expect(ctx.agentCollection.findOne).toHaveBeenCalledWith({ _id: host, deletedAt: { $exists: false } });
      expectNoWorkWrites(ctx);
    },
  );

  it("rejects a host derived from a single-submit profile", async () => {
    const ctx = harness([], [makeAgent(host, false)], [makeProfileVersion("host-profile", host)]);
    const res = await request(ctx.app).post(`/api/v1/requests?projectId=${PROJECT_ID}`)
      .send({ ...SUBMIT, profileId: "host-profile" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: `Worker "${host}" is not available for new submissions` });
    expectNoWorkWrites(ctx);
  });

  it("rejects a profile-derived host on bulk resubmit", async () => {
    const ctx = harness([makeRequest(DOCKER)], [makeAgent(host, false)], [makeProfileVersion("host-profile", host)]);
    const res = await request(ctx.app).post("/api/v1/requests/bulk-resubmit")
      .send({ ids: ["original"], overrides: { profileId: "host-profile" } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: `Worker "${host}" is not available for new submissions` });
    expectNoWorkWrites(ctx);
  });

  it("checks the retained pinned profile before a conflicting Docker worker override", async () => {
    const pinned = makeProfileVersion("profile", host);
    const latest = makeProfileVersion("profile", DOCKER, 2);
    const ctx = harness(
      [makeRequest(DOCKER, { profileId: "profile", profileVersionId: pinned.ref })],
      [makeAgent(host, false)],
      [pinned, latest],
    );
    const res = await request(ctx.app).post("/api/v1/requests/bulk-resubmit")
      .send({ ids: ["original"], overrides: { workerType: DOCKER } });
    expect(res.status).toBe(400);
    expect(ctx.profileVersionCollection.findOne).toHaveBeenCalledWith({
      projectId: PROJECT_ID, $or: [{ ref: pinned.ref }, { _id: pinned.ref }],
    });
    expectNoWorkWrites(ctx);
  });

  it.each(["base", "variation"] as const)("rejects a disabled %s host in a pinned variation batch atomically", async (position) => {
    const ctx = harness([], [makeAgent(host, false)], [
      makeProfileVersion("docker", DOCKER),
      makeProfileVersion("host", host),
      makeProfileVersion("host", DOCKER, 2),
    ]);
    const res = await request(ctx.app).post(`/api/v1/requests?projectId=${PROJECT_ID}`).send({
      ...SUBMIT,
      count: 2,
      profileId: position === "base" ? "host@1" : "docker",
      profileVariations: [position === "base" ? "docker" : "host@1"],
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: `Worker "${host}" is not available for new submissions`,
      variationProfileId: "host",
    });
    expectNoWorkWrites(ctx);
  });

  it.each(["retry", "resume"] as const)("rejects %s before changing history or the current attempt", async (action) => {
    const original = makeRequest(host, {
      run: { _id: "attempt-1", attemptNumber: 1, status: action === "retry" ? "done" : "paused", outcome: "succeeded" },
    });
    const ctx = harness([original], [makeAgent(host, false)]);
    const res = await request(ctx.app).post(`/api/v1/requests/original/${action}`).send({ force: true });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: `Worker "${host}" is not available for new submissions` });
    expectNoWorkWrites(ctx);
  });

  it("skips a disabled host in bulk retry without demoting it or blocking Docker", async () => {
    const ctx = harness([makeRequest(host), makeRequest(DOCKER, { _id: "docker" })], [makeAgent(host, false)]);
    const res = await request(ctx.app).post("/api/v1/requests/bulk-retry")
      .send({ ids: ["original", "docker", "missing"] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      retried: 1,
      skipped: 2,
      results: [
        { requestId: "original", error: `Worker "${host}" is not available for new submissions` },
        { requestId: "docker", attemptNumber: 2 },
        { requestId: "missing", error: "Not found" },
      ],
    });
    expect(ctx.runsCollection.insertOne).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      requestId: "docker", projectId: PROJECT_ID,
    }));
    expect(ctx.requestCollection.updateOne).toHaveBeenCalledExactlyOnceWith(
      { _id: "docker", "run._id": "attempt-1" }, expect.any(Object),
    );
  });

  it("excludes disabled hosts from bulk resume while preserving its counters", async () => {
    const ctx = harness([
      makeRequest(host, { run: { _id: "attempt-1", attemptNumber: 1, status: "paused" } }),
      makeRequest(DOCKER, { _id: "docker", run: { _id: "attempt-2", attemptNumber: 1, status: "paused" } }),
    ]);
    const res = await request(ctx.app).post("/api/v1/requests/bulk-resume")
      .send({ ids: ["original", "docker"] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 1, skipped: 1 });
    expect(ctx.requestCollection.updateMany).toHaveBeenCalledExactlyOnceWith(
      { _id: { $in: ["docker"] }, "run.status": "paused", deletedAt: { $exists: false } },
      expect.objectContaining({ $set: expect.objectContaining({ "run.status": "pending" }) }),
    );
  });

  it.each(["bulk-retry", "bulk-resume"] as const)("does not mutate an all-disabled %s batch", async (action) => {
    const ctx = harness([makeRequest(host, {
      run: { _id: "attempt-1", attemptNumber: 1, status: action === "bulk-retry" ? "done" : "paused" },
    })]);
    const res = await request(ctx.app).post(`/api/v1/requests/${action}`).send({ ids: ["original"] });
    expect(res.status).toBe(action === "bulk-retry" ? 201 : 200);
    expect(res.body).toMatchObject({ skipped: 1 });
    expectNoWorkWrites(ctx);
  });

  it.each(["worker", "detached-profile", "docker-profile"] as const)("allows replacing a disabled original host via %s", async (source) => {
    const ctx = harness([makeRequest(host, source === "detached-profile"
      ? { profileId: "host-profile", profileVersionId: "host-profile@1" } : {})],
    [makeAgent(host, false)], [makeProfileVersion("host-profile", host), makeProfileVersion("docker-profile", DOCKER)]);
    const overrides = source === "docker-profile"
      ? { profileId: "docker-profile" }
      : { workerType: DOCKER, ...(source === "detached-profile" ? { profileId: null } : {}) };
    const res = await request(ctx.app).post("/api/v1/requests/bulk-resubmit")
      .send({ ids: ["original", "missing"], count: 2, overrides });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ submitted: 2, failed: ["missing"] });
    expect(ctx.requestCollection.insertMany).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({ workerType: DOCKER, projectId: PROJECT_ID }),
      expect.objectContaining({ workerType: DOCKER, projectId: PROJECT_ID }),
    ]);
    expect(ctx.agentCollection.findOne).not.toHaveBeenCalledWith(expect.objectContaining({ _id: host }));
  });

  it.each(["retry", "resume", "bulk-resubmit", "bulk-retry", "bulk-resume"] as const)(
    "allows an explicitly available host through %s",
    async (action) => {
      const ctx = harness([makeRequest(host, {
        run: { _id: "attempt-1", attemptNumber: 1, status: action.includes("resume") ? "paused" : "done" },
      })], [makeAgent(host, true)]);
      const path = action.startsWith("bulk-") ? action : `original/${action}`;
      const res = await request(ctx.app).post(`/api/v1/requests/${path}`).send({ ids: ["original"] });
      expect(res.status).toBe(action.includes("resume") ? 200 : 201);
    },
  );
});

it("allows available host variation fan-out", async () => {
  const ctx = harness([], HOSTS.map((host) => makeAgent(host, true)), [
    makeProfileVersion("copilot", HOSTS[0]), makeProfileVersion("claude", HOSTS[1]),
  ]);
  const res = await request(ctx.app).post(`/api/v1/requests?projectId=${PROJECT_ID}`)
    .send({ ...SUBMIT, profileId: "copilot", profileVariations: ["claude"], count: 2 });
  expect(res.status).toBe(201);
  expect(res.body).toMatchObject({ count: 4, variationCount: 2, status: "pending" });
  expect(ctx.requestCollection.insertMany).toHaveBeenCalledExactlyOnceWith([
    expect.objectContaining({ workerType: HOSTS[0] }), expect.objectContaining({ workerType: HOSTS[0] }),
    expect.objectContaining({ workerType: HOSTS[1] }), expect.objectContaining({ workerType: HOSTS[1] }),
  ]);
});

it("does not attempt to resume a request that was not admitted as paused", async () => {
  const ctx = harness([makeRequest(HOSTS[0], {
    run: { _id: "attempt-1", attemptNumber: 1, status: "pending" },
  })], [makeAgent(HOSTS[0], false)]);
  const res = await request(ctx.app).post("/api/v1/requests/original/resume").send({});
  expect(res.status).toBe(409);
  expectNoWorkWrites(ctx);
});

it("bulk resume writes only the requests included in its admission read", async () => {
  const docker = makeRequest(DOCKER, {
    _id: "docker", run: { _id: "docker-attempt", attemptNumber: 1, status: "paused" },
  });
  const lateHost = makeRequest(HOSTS[0], {
    run: { _id: "host-attempt", attemptNumber: 1, status: "paused" },
  });
  const ctx = harness([docker, lateHost], [makeAgent(HOSTS[0], false)]);
  const cursor = ctx.requestCollection.find({});
  vi.spyOn(cursor, "toArray").mockResolvedValue([docker]);
  vi.mocked(ctx.requestCollection.find).mockReturnValueOnce(cursor);
  const res = await request(ctx.app).post("/api/v1/requests/bulk-resume")
    .send({ ids: ["docker", "original"] });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ updated: 1, skipped: 1 });
  expect(ctx.requestCollection.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({ _id: { $in: ["docker"] } }), expect.anything(),
  );
});

it.each(["retry", "resume", "bulk-retry", "bulk-resume", "bulk-resubmit"] as const)(
  "leaves Docker-only %s admission unchanged",
  async (action) => {
    const ctx = harness([makeRequest(DOCKER, {
      run: { _id: "attempt-1", attemptNumber: 1, status: action.includes("resume") ? "paused" : "done" },
    })], [makeAgent(DOCKER, false)]);
    const path = action.startsWith("bulk-") ? action : `original/${action}`;
    const res = await request(ctx.app).post(`/api/v1/requests/${path}`).send({ ids: ["original"] });
    expect(res.status).toBe(action.includes("resume") ? 200 : 201);
    if (action !== "bulk-resubmit") expect(ctx.agentCollection.findOne).not.toHaveBeenCalled();
  },
);
