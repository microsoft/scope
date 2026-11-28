// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { randomUUID } from "node:crypto";
import type { Collection } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { app, _injectTestDependencies } from "./index.js";
import type { CodingAgentDocument, ReportTemplateDocument, RequestDocument } from "./route-context.js";
import { createAllMockDependencies, createMockCollection } from "./test-helpers.js";
import { useTestServer } from "./test-server.js";

/** A completed parent whose project is inherited by resubmissions and reports. */
function parentRun(projectId: string): RequestDocument {
  return {
    _id: randomUUID(),
    projectId,
    scenario: { task: "Render a greeting", criteria: ["greeting"] },
    workerType: "coder-acp-copilot",
    priority: 0,
    createdAt: new Date(),
    run: { _id: randomUUID(), attemptNumber: 1, status: "done", outcome: "succeeded" },
  };
}

const routes = [
  {
    path: "/requests/bulk-resubmit",
    bulk: true,
    body: (ids: string[]) => ({ ids, count: 1 }),
  },
  {
    path: "/reports",
    bulk: false,
    body: (ids: string[]) => ({ requestId: ids[0] }),
  },
  {
    path: "/reports/bulk-create",
    bulk: true,
    body: (ids: string[]) => ({ requestIds: ids }),
  },
  {
    path: "/reports/trigger",
    bulk: false,
    body: (ids: string[]) => ({ requestId: ids[0] }),
  },
  {
    path: "/reports/bulk-trigger",
    bulk: true,
    body: (ids: string[]) => ({ requestIds: ids }),
  },
];

describe("parent-derived project writes", () => {
  const testServer = useTestServer(app);
  let mocks: ReturnType<typeof createAllMockDependencies>;
  let collection: Collection<RequestDocument>;
  let agentCollection: Collection<CodingAgentDocument>;
  let reportTemplateCollection: Collection<ReportTemplateDocument>;

  beforeEach(() => {
    mocks = createAllMockDependencies();
    agentCollection = createMockCollection<CodingAgentDocument>([{
      _id: "coder-acp-copilot",
      name: "Fixture worker",
      createdAt: new Date(),
      available: true,
      supportedModels: [],
      versions: [{
        agentVersion: "1.0.0",
        workerVersion: "1.0.0",
        components: {},
        gitCommit: "fixture",
        buildTime: "2026-01-01T00:00:00Z",
        imageTag: "fixture",
        status: "active",
        queueName: "fixture-worker",
        createdAt: new Date(),
      }],
    }]);
    reportTemplateCollection = createMockCollection<ReportTemplateDocument>([{
      id: "greeting-report",
      name: "Greeting report",
      userPrompt: "Summarize the greeting",
      projectId: "fixture-template-project",
      createdAt: new Date(),
      trigger: { type: "always" },
    }]);
  });

  describe.each(routes)("POST $path", ({ path, bulk, body }) => {
    it.each([
      { status: 404, withQuery: false },
      { status: 404, withQuery: true },
      { status: 409, withQuery: false },
      { status: 409, withQuery: true },
    ])("rejects an unavailable parent project with $status (query=$withQuery) before writing", async ({ status, withQuery }) => {
      const unavailableProject = randomUUID();
      const liveProject = randomUUID();
      const runs = [
        ...(bulk ? [parentRun(liveProject)] : []),
        parentRun(unavailableProject),
      ];
      collection = createMockCollection(runs);
      mocks.projectStore.get.mockImplementation(async (id) => {
        if (id === unavailableProject && status === 404) return null;
        return {
          _id: id,
          name: "Fixture project",
          createdAt: new Date(),
          ...(id === unavailableProject ? { deletedAt: new Date() } : {}),
        };
      });
      _injectTestDependencies({ ...mocks, collection, agentCollection, reportTemplateCollection });

      const query = withQuery ? `?projectId=${liveProject}` : "";
      const response = await request(testServer())
        .post(`/api/v1${path}${query}`)
        .send(body(runs.map(run => run._id)));

      expect(response.status).toBe(status);
      expect(response.body.error).toBe(status === 404
        ? `Project '${unavailableProject}' not found.`
        : `Project '${unavailableProject}' is deleted; restore it before writing to it.`);
      expect(mocks.projectStore.get).toHaveBeenCalledWith(unavailableProject, { includeDeleted: true });
      expect(collection.insertMany).not.toHaveBeenCalled();
      expect(mocks.reportCollection.insertOne).not.toHaveBeenCalled();
      expect(mocks.reportQueueClient.sendMessage).not.toHaveBeenCalled();
    });

    it("writes to the resolved live projects and checks each distinct destination once", async () => {
      const firstProject = randomUUID();
      const secondProject = randomUUID();
      const runs = bulk
        ? [parentRun(firstProject), parentRun(secondProject), parentRun(firstProject)]
        : [parentRun(firstProject)];
      collection = createMockCollection(runs);
      _injectTestDependencies({ ...mocks, collection, agentCollection, reportTemplateCollection });

      const response = await request(testServer())
        .post(`/api/v1${path}`)
        .send(body(runs.map(run => run._id)));

      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(mocks.projectStore.get).toHaveBeenCalledTimes(bulk ? 2 : 1);
      expect(mocks.projectStore.get).toHaveBeenCalledWith(firstProject, { includeDeleted: true });
      if (bulk) {
        expect(mocks.projectStore.get).toHaveBeenCalledWith(secondProject, { includeDeleted: true });
      }
      const written = path === "/requests/bulk-resubmit"
        ? vi.mocked(collection.insertMany).mock.calls[0][0]
        : vi.mocked(mocks.reportCollection.insertOne).mock.calls.map(([doc]) => doc);
      expect(written.map(doc => doc.projectId)).toEqual(runs.map(run => run.projectId));
      expect(mocks.reportQueueClient.sendMessage).toHaveBeenCalledTimes(path === "/requests/bulk-resubmit" ? 0 : runs.length);
    });
  });
});
