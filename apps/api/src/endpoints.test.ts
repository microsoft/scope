// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { app, _injectTestDependencies } from "./index.js";
import { useTestServer } from "./test-server.js";
import { _resetRunFacetsCacheForTests } from "./routes/requests/index.js";
import { createAllMockDependencies, createMockCollection } from "./test-helpers.js";

const TEST_PROJECT_ID = "test-project";

// Stub checkMigrations before it can be imported by index.ts
vi.mock("db-migrations/check-migrations", () => ({
  checkMigrations: vi.fn().mockResolvedValue({
    ready: true,
    applied: ["001", "002"],
    pending: [],
  }),
}));

// Stub LLM helpers — not testing AI generation
vi.mock("./llm.js", () => ({
  isLlmAvailable: vi.fn().mockReturnValue(false),
  generateCriteriaPrompt: vi.fn(),
}));
vi.mock("./prompt-feature-llm.js", () => ({
  isLlmAvailable: vi.fn().mockReturnValue(false),
  generatePromptFeaturePrompt: vi.fn(),
  extractPromptFeatures: vi.fn(),
}));
vi.mock("./task-prompt-llm.js", () => ({
  isTaskPromptLlmAvailable: vi.fn().mockReturnValue(false),
  generateTaskPrompt: vi.fn(),
}));

describe("API Endpoints", () => {
  // One persistent server for the whole file (see useTestServer): handing the
  // Express app straight to supertest would spin up a fresh server per call and
  // leak sockets, intermittently corrupting later requests.
  const testServer = useTestServer(app);
  let mocks: ReturnType<typeof createAllMockDependencies>;

  beforeAll(() => {
    mocks = createAllMockDependencies();
    _injectTestDependencies(mocks);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-inject after clearAllMocks so the mock implementations are fresh
    mocks = createAllMockDependencies();
    _injectTestDependencies(mocks);
    (mocks.agentCollection.findOne as any).mockResolvedValue({
      _id: "coder-acp-copilot",
      name: "Copilot",
      available: true,
      supportedModels: [],
      versions: [
        {
          agentVersion: "1.0.0",
          status: "active",
          queueName: "queue-coder-acp-copilot",
          createdAt: new Date(),
        },
      ],
      createdAt: new Date(),
    });
    // Facets are memoized in a module-level cache; clear it so each test starts cold
    _resetRunFacetsCacheForTests();
  });

  // ===================================================================
  // Utility endpoints
  // ===================================================================

  describe("GET /health", () => {
    it("returns 200 with status healthy", async () => {
      const res = await request(testServer()).get("/health");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("status", "healthy");
      expect(res.body).toHaveProperty("version");
    });
  });

  describe("GET /ready", () => {
    it("returns 200 when migrations are ready", async () => {
      const { checkMigrations } = await import("db-migrations/check-migrations");
      (checkMigrations as any).mockResolvedValue({
        ready: true,
        applied: ["001", "002"],
        pending: [],
      });

      const res = await request(testServer()).get("/ready");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ready");
    });

    it("returns 503 when migrations are not ready", async () => {
      const { checkMigrations } = await import("db-migrations/check-migrations");
      (checkMigrations as any).mockResolvedValue({
        ready: false,
        applied: ["001"],
        pending: ["002"],
      });

      const res = await request(testServer()).get("/ready");
      expect(res.status).toBe(503);
      expect(res.body.status).toBe("not-ready");
    });
  });

  describe("GET /about", () => {
    it("returns 200 with name and version", async () => {
      const res = await request(testServer()).get("/about");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("name");
      expect(res.body).toHaveProperty("version");
      expect(res.body).toHaveProperty("workers");
    });
  });

  describe("GET /api/v1/version", () => {
    it("returns 200 with commit and build info", async () => {
      const res = await request(testServer()).get("/api/v1/version");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("commit");
      expect(res.body).toHaveProperty("buildTime");
      expect(res.body).toHaveProperty("strictAgentCapabilities", false);
      expect(res.body).toHaveProperty("environment");
    });
  });

  // ===================================================================
  // Project scoping enforcement (Data Organization: Projects)
  // A scoped list / root create with no ?projectId= must fail fast with
  // 400 — there is no default project. Point reads by :id stay unscoped.
  // ===================================================================

  describe("project scoping enforcement", () => {
    it("400s a top-level runs list with no projectId", async () => {
      const res = await request(testServer()).get("/api/v1/requests");
      expect(res.status).toBe(400);
    });

    it("400s the runs facets endpoint with no projectId", async () => {
      const res = await request(testServer()).get("/api/v1/requests/facets");
      expect(res.status).toBe(400);
    });

    it("400s a top-level criteria list with no projectId", async () => {
      const res = await request(testServer()).get("/api/v1/criteria");
      expect(res.status).toBe(400);
    });

    it("400s a root criteria create with no projectId", async () => {
      // findOne → null means this would 201 if scoping were not enforced.
      (mocks.criteriaCollection.findOne as any).mockResolvedValue(null);
      const res = await request(testServer())
        .post("/api/v1/criteria")
        .send({ id: "unscoped_crit", prompt: "No project?", dependsOn: [] });
      expect(res.status).toBe(400);
    });

    it("rejects a by-id point read with no projectId (400 — never a global slug-only resolve)", async () => {
      const doc = { id: "c1", prompt: "Check it", dependsOn: [], createdAt: new Date() };
      (mocks.criteriaCollection.findOne as any).mockResolvedValue(doc);
      const res = await request(testServer()).get("/api/v1/criteria/c1");
      expect(res.status).toBe(400);
    });

    it("allows a scoped list once projectId is supplied", async () => {
      const cursor = {
        toArray: vi.fn().mockResolvedValue([]),
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
      };
      (mocks.criteriaCollection.find as any).mockReturnValue(cursor);
      const res = await request(testServer()).get(`/api/v1/criteria?projectId=${TEST_PROJECT_ID}`);
      expect(res.status).toBe(200);
    });
  });

  // ===================================================================
  // Criteria endpoints
  // ===================================================================

  describe("GET /api/v1/criteria", () => {
    it("returns 200 with array of criteria", async () => {
      const mockCriteria = [{ id: "c1", prompt: "Test", dependsOn: [], createdAt: new Date() }];
      const cursor = {
        toArray: vi.fn().mockResolvedValue(mockCriteria),
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        project: vi.fn().mockReturnThis(),
      };
      (mocks.criteriaCollection.find as any).mockReturnValue(cursor);

      const res = await request(testServer()).get(`/api/v1/criteria?projectId=${TEST_PROJECT_ID}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe("POST /api/v1/criteria", () => {
    it("returns 201 when creating a new criterion", async () => {
      // findOne returns null (no duplicate)
      (mocks.criteriaCollection.findOne as any).mockResolvedValue(null);

      const res = await request(testServer())
        .post(`/api/v1/criteria?projectId=${TEST_PROJECT_ID}`)
        .send({ id: "new_crit", prompt: "Does it work?", dependsOn: [] });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id", "new_crit");
    });

    it("returns 409 when criterion already exists", async () => {
      (mocks.criteriaCollection.findOne as any).mockResolvedValue({
        id: "existing",
        prompt: "Old prompt",
        createdAt: new Date(),
      });

      const res = await request(testServer())
        .post(`/api/v1/criteria?projectId=${TEST_PROJECT_ID}`)
        .send({ id: "existing", prompt: "Duplicate", dependsOn: [] });

      expect(res.status).toBe(409);
    });

    it("returns 400 when creating a criterion that introduces a cycle", async () => {
      const dataset = [
        { id: "a", prompt: "A", dependsOn: ["b"], createdAt: new Date() },
      ];
      (mocks.criteriaCollection.findOne as any).mockImplementation((f: any) =>
        Promise.resolve(dataset.find((d) => d.id === f.id) ?? null),
      );
      (mocks.criteriaCollection.find as any).mockReturnValue({
        sort: () => ({ toArray: () => Promise.resolve(dataset) }),
        toArray: () => Promise.resolve(dataset),
      });

      const res = await request(testServer())
        .post(`/api/v1/criteria?projectId=${TEST_PROJECT_ID}`)
        .send({ id: "b", prompt: "B", dependsOn: ["a"] });

      expect(res.status).toBe(400);
    });

    it("returns 400 when a dependency is not gate-compatible", async () => {
      const dataset = [
        { id: "parent", prompt: "P", dependsOn: [], gates: ["select"], createdAt: new Date() },
      ];
      (mocks.criteriaCollection.findOne as any).mockImplementation((f: any) =>
        Promise.resolve(dataset.find((d) => d.id === f.id) ?? null),
      );
      (mocks.criteriaCollection.find as any).mockReturnValue({
        sort: () => ({ toArray: () => Promise.resolve(dataset) }),
        toArray: () => Promise.resolve(dataset),
      });

      const res = await request(testServer())
        .post(`/api/v1/criteria?projectId=${TEST_PROJECT_ID}`)
        .send({ id: "child", prompt: "C", dependsOn: ["parent"], gates: ["select", "build"] });

      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/v1/criteria/seed", () => {
    it("returns 400 when the seeded batch would form a cycle", async () => {
      (mocks.criteriaCollection.find as any).mockReturnValue({
        toArray: () => Promise.resolve([]),
        sort: () => ({ toArray: () => Promise.resolve([]) }),
      });

      const res = await request(testServer())
        .post(`/api/v1/criteria/seed?projectId=${TEST_PROJECT_ID}`)
        .send({
          criteria: [
            { id: "a", prompt: "A", dependsOn: ["b"] },
            { id: "b", prompt: "B", dependsOn: ["a"] },
          ],
        });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/v1/criteria/:id", () => {
    it("returns 200 when criterion exists", async () => {
      const doc = { id: "c1", prompt: "Check it", dependsOn: [], createdAt: new Date() };
      (mocks.criteriaCollection.findOne as any).mockResolvedValue(doc);
      const depCursor = { toArray: vi.fn().mockResolvedValue([]) };
      (mocks.criteriaCollection.find as any).mockReturnValue(depCursor);

      const res = await request(testServer()).get(`/api/v1/criteria/c1?projectId=${TEST_PROJECT_ID}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe("c1");
    });

    it("returns 404 when criterion not found", async () => {
      (mocks.criteriaCollection.findOne as any).mockResolvedValue(null);

      const res = await request(testServer()).get(`/api/v1/criteria/nonexistent?projectId=${TEST_PROJECT_ID}`);
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /api/v1/criteria/:id", () => {
    it("returns 200 when updating existing criterion", async () => {
      const existing = { id: "c1", prompt: "Old", dependsOn: [], createdAt: new Date() };
      (mocks.criteriaCollection.findOne as any)
        .mockResolvedValueOnce(existing)   // existence check
        .mockResolvedValueOnce({ ...existing, prompt: "Updated" }); // after update

      const res = await request(testServer())
        .put(`/api/v1/criteria/c1?projectId=${TEST_PROJECT_ID}`)
        .send({ prompt: "Updated" });

      expect(res.status).toBe(200);
    });

    it("returns 404 when criterion not found", async () => {
      (mocks.criteriaCollection.findOne as any).mockResolvedValue(null);

      const res = await request(testServer())
        .put(`/api/v1/criteria/missing?projectId=${TEST_PROJECT_ID}`)
        .send({ prompt: "Nope" });

      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/v1/criteria/:id", () => {
    it("returns 200 when deleting criterion with no dependents", async () => {
      (mocks.criteriaCollection.findOne as any).mockResolvedValue({
        id: "c1",
        prompt: "Del me",
        dependsOn: [],
        createdAt: new Date(),
      });
      (mocks.criteriaCollection.find as any).mockReturnValue({
        toArray: vi.fn().mockResolvedValue([]),
      });

      const res = await request(testServer()).delete(`/api/v1/criteria/c1?projectId=${TEST_PROJECT_ID}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("deleted", true);
    });

    it("returns 404 when criterion not found", async () => {
      (mocks.criteriaCollection.findOne as any).mockResolvedValue(null);

      const res = await request(testServer()).delete(`/api/v1/criteria/missing?projectId=${TEST_PROJECT_ID}`);
      expect(res.status).toBe(404);
    });

    it("returns 409 when criterion has dependents", async () => {
      (mocks.criteriaCollection.findOne as any).mockResolvedValue({
        id: "c1",
        prompt: "Parent",
        dependsOn: [],
        createdAt: new Date(),
      });
      (mocks.criteriaCollection.find as any).mockReturnValue({
        toArray: vi.fn().mockResolvedValue([{ id: "child" }]),
      });

      const res = await request(testServer()).delete(`/api/v1/criteria/c1?projectId=${TEST_PROJECT_ID}`);
      expect(res.status).toBe(409);
    });
  });

  // ===================================================================
  // Agents endpoints
  // ===================================================================

  describe("GET /api/v1/agents", () => {
    it("returns 200 with array of agents", async () => {
      const agents = [{ _id: "coder-acp-copilot", name: "Copilot", supportedModels: [], createdAt: new Date() }];
      (mocks.agentCollection.find as any).mockReturnValue({
        toArray: vi.fn().mockResolvedValue(agents),
      });

      const res = await request(testServer()).get("/api/v1/agents");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0]).toHaveProperty("id", "coder-acp-copilot");
    });
  });

  describe("POST /api/v1/agents", () => {
    it("returns 201 when creating a new agent", async () => {
      (mocks.agentCollection.findOne as any).mockResolvedValue(null);

      const res = await request(testServer())
        .post("/api/v1/agents")
        .send({ _id: "new-agent", name: "New Agent" });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id", "new-agent");
    });

    it("returns 400 when _id missing", async () => {
      const res = await request(testServer())
        .post("/api/v1/agents")
        .send({ name: "No ID" });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/v1/agents/:id", () => {
    it("returns 200 when agent exists", async () => {
      const doc = { _id: "agent-1", name: "Agent One", supportedModels: [], createdAt: new Date() };
      (mocks.agentCollection.findOne as any).mockResolvedValue(doc);

      const res = await request(testServer()).get("/api/v1/agents/agent-1");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("id", "agent-1");
    });

    it("returns 404 when agent not found", async () => {
      (mocks.agentCollection.findOne as any).mockResolvedValue(null);

      const res = await request(testServer()).get("/api/v1/agents/missing");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/v1/agents/:id/versions", () => {
    const versionPayload = {
      agentVersion: "synthetic-v1",
      workerVersion: "synthetic-build",
      components: {},
      gitCommit: "abc1234",
      buildTime: "20260101T000000Z",
      imageTag: "synthetic-build",
      queueName: "synthetic-dynamic-queue",
    };

    it("retries when the versions snapshot changes during registration", async () => {
      const agent = {
        _id: "synthetic-worker",
        versions: [],
      };
      (mocks.agentCollection.findOne as any).mockResolvedValue(agent);
      (mocks.agentCollection.updateOne as any)
        .mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 })
        .mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1 });

      const res = await request(app)
        .post("/api/v1/agents/synthetic-worker/versions")
        .send(versionPayload);

      expect(res.status).toBe(201);
      expect((mocks.agentCollection.updateOne as any).mock.calls[1][0]).toMatchObject({
        _id: "synthetic-worker",
        versions: agent.versions,
      });
    });

    it("converges on an entry inserted by a concurrent registration", async () => {
      const initialAgent = {
        _id: "synthetic-worker",
        versions: [],
      };
      const concurrentVersion = {
        ...versionPayload,
        status: "active",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      };
      const concurrentlyUpdatedAgent = {
        ...initialAgent,
        versions: [concurrentVersion],
      };
      (mocks.agentCollection.findOne as any)
        .mockResolvedValueOnce(initialAgent)
        .mockResolvedValueOnce(concurrentlyUpdatedAgent);
      (mocks.agentCollection.updateOne as any)
        .mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 })
        .mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1 });

      const res = await request(app)
        .post("/api/v1/agents/synthetic-worker/versions")
        .send(versionPayload);

      expect(res.status).toBe(200);
      expect(mocks.agentCollection.updateOne).toHaveBeenCalledTimes(2);
      expect((mocks.agentCollection.updateOne as any).mock.calls[1][0]).toMatchObject({
        _id: "synthetic-worker",
        versions: concurrentlyUpdatedAgent.versions,
      });
    });
  });

  // ===================================================================
  // Profiles endpoints
  // ===================================================================

  describe("POST /api/v1/profiles", () => {
    it("returns 400 when the target agent has no supportedModels", async () => {
      (mocks.agentCollection.findOne as any).mockResolvedValue({
        _id: "coder-acp-copilot",
        name: "Copilot",
        available: true,
        supportedModels: [],
        versions: [
          {
            agentVersion: "1.0.0",
            status: "active",
            queueName: "queue-coder-acp-copilot",
            createdAt: new Date(),
          },
        ],
      });

      const res = await request(testServer())
        .post(`/api/v1/profiles?projectId=${TEST_PROJECT_ID}`)
        .send({
          name: "test profile",
          description: "",
          workerType: "coder-acp-copilot",
          model: "gpt-5",
          agentVersion: "1.0.0",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/does not declare any supportedModels/);
    });

    it("returns 400 when model is not in the agent's supportedModels", async () => {
      (mocks.agentCollection.findOne as any).mockResolvedValue({
        _id: "coder-acp-copilot",
        name: "Copilot",
        available: true,
        supportedModels: ["gpt-5"],
        versions: [
          {
            agentVersion: "1.0.0",
            status: "active",
            queueName: "queue-coder-acp-copilot",
            createdAt: new Date(),
          },
        ],
      });

      const res = await request(testServer())
        .post(`/api/v1/profiles?projectId=${TEST_PROJECT_ID}`)
        .send({
          name: "test profile",
          description: "",
          workerType: "coder-acp-copilot",
          model: "claude-3-opus",
          agentVersion: "1.0.0",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid model/);
      expect(res.body.supportedModels).toEqual(["gpt-5"]);
    });

    it("returns 404 when the target agent does not exist", async () => {
      (mocks.agentCollection.findOne as any).mockResolvedValue(null);

      const res = await request(testServer())
        .post(`/api/v1/profiles?projectId=${TEST_PROJECT_ID}`)
        .send({
          name: "test profile",
          description: "",
          workerType: "ghost-agent",
          model: "gpt-5",
          agentVersion: "1.0.0",
        });

      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not registered/);
    });
  });

  // ===================================================================
  // Models endpoints
  // ===================================================================

  describe("GET /api/v1/models", () => {
    it("returns 200 with array of models", async () => {
      const models = [{ _id: "agent:gpt-4", modelId: "gpt-4", provider: "github", agentId: "agent" }];
      (mocks.modelCollection.find as any).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue(models),
        }),
      });

      const res = await request(testServer()).get("/api/v1/models");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  // ===================================================================
  // Insights endpoints
  // ===================================================================

  describe("GET /api/v1/insights", () => {
    it("returns 200 with array of insights", async () => {
      const insights = [{ _id: "i1", title: "Test", description: "desc", createdAt: new Date() }];
      (mocks.insightsCollection.find as any).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue(insights),
        }),
      });

      const res = await request(testServer()).get(`/api/v1/insights?projectId=${TEST_PROJECT_ID}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0]).toHaveProperty("id", "i1");
    });
  });

  describe("POST /api/v1/insights", () => {
    it("returns 201 when creating an insight", async () => {
      const res = await request(testServer())
        .post(`/api/v1/insights?projectId=${TEST_PROJECT_ID}`)
        .send({ title: "New Insight", description: "Something learned" });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("title", "New Insight");
      expect(res.body).toHaveProperty("id");
    });

    it("returns 400 when title missing", async () => {
      const res = await request(testServer())
        .post(`/api/v1/insights?projectId=${TEST_PROJECT_ID}`)
        .send({ description: "No title" });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/v1/insights/:id", () => {
    it("returns 200 when insight exists", async () => {
      const doc = { _id: "i1", title: "Insight", description: "details", createdAt: new Date() };
      (mocks.insightsCollection.findOne as any).mockResolvedValue(doc);

      const res = await request(testServer()).get("/api/v1/insights/i1");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("id", "i1");
    });

    it("returns 404 when insight not found", async () => {
      (mocks.insightsCollection.findOne as any).mockResolvedValue(null);

      const res = await request(testServer()).get("/api/v1/insights/missing");
      expect(res.status).toBe(404);
    });
  });

  // ===================================================================
  // Requests endpoints
  // ===================================================================

  describe("GET /api/v1/requests", () => {
    it("returns 200 with paginated response", async () => {
      const docs = [{ _id: "r1", scenario: { task: "t", criteria: [] }, workerType: "coder-acp-copilot", status: "completed", createdAt: new Date() }];
      (mocks.collection.find as any).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            toArray: vi.fn().mockResolvedValue(docs),
          }),
        }),
      });

      const res = await request(testServer()).get(`/api/v1/requests?projectId=${TEST_PROJECT_ID}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("data");
      expect(res.body).toHaveProperty("limit");
      expect(res.body).toHaveProperty("estimatedTotal");
      expect(res.body).toHaveProperty("cursors");
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data[0]).toHaveProperty("id", "r1");
    });

    it("returns grouped results when groupBy=task", async () => {
      const groupedDocs = [
        { key: "tp-1", label: "Build a calculator", aggregates: { count: 3, turns: { min: 1, max: 3, mean: 2, stdDev: 0.8 }, duration: null, promptTokens: null, completionTokens: null }, uniform: { workerType: "coder-acp-copilot" } },
      ];
      // aggregate is called multiple times: key pipeline, phase2, hasMoreAfter, hasMoreBefore
      (mocks.collection.aggregate as any)
        .mockReturnValueOnce({ toArray: vi.fn().mockResolvedValue([{ _id: "tp-1" }]) }) // keys
        .mockReturnValueOnce({ toArray: vi.fn().mockResolvedValue(groupedDocs) }) // phase2
        .mockReturnValueOnce({ toArray: vi.fn().mockResolvedValue([]) }) // hasMoreAfter
        .mockReturnValueOnce({ toArray: vi.fn().mockResolvedValue([]) }); // hasMoreBefore

      const res = await request(testServer()).get(`/api/v1/requests?groupBy=task&projectId=${TEST_PROJECT_ID}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("data");
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data[0]).toHaveProperty("key", "tp-1");
      expect(res.body.data[0]).toHaveProperty("aggregates");
      expect(res.body.data[0].aggregates).toHaveProperty("count", 3);
      expect(res.body.data[0]).toHaveProperty("uniform");
    });

    it("returns grouped results when groupBy=submissionId", async () => {
      const groupedDocs = [
        { key: "sub-1", label: "sub-1", aggregates: { count: 2, turns: null, duration: null, promptTokens: null, completionTokens: null }, uniform: {} },
      ];
      (mocks.collection.aggregate as any)
        .mockReturnValueOnce({ toArray: vi.fn().mockResolvedValue([{ _id: "sub-1" }]) })
        .mockReturnValueOnce({ toArray: vi.fn().mockResolvedValue(groupedDocs) })
        .mockReturnValueOnce({ toArray: vi.fn().mockResolvedValue([]) })
        .mockReturnValueOnce({ toArray: vi.fn().mockResolvedValue([]) });

      const res = await request(testServer()).get(`/api/v1/requests?groupBy=submissionId&projectId=${TEST_PROJECT_ID}`);
      expect(res.status).toBe(200);
      expect(res.body.data[0]).toHaveProperty("key", "sub-1");
    });

    it("calls aggregate pipeline when groupBy is provided", async () => {
      (mocks.collection.aggregate as any)
        .mockReturnValueOnce({ toArray: vi.fn().mockResolvedValue([]) }); // keys (empty)

      await request(testServer()).get(`/api/v1/requests?groupBy=task&projectId=${TEST_PROJECT_ID}`);
      expect(mocks.collection.aggregate).toHaveBeenCalled();
      // Phase 1 key pipeline: $match, $group, $sort, $limit
      const pipeline = (mocks.collection.aggregate as any).mock.calls[0][0];
      expect(pipeline[0]).toHaveProperty("$match");
      expect(pipeline[1]).toHaveProperty("$group");
    });

    it("does not call aggregate when groupBy is absent", async () => {
      (mocks.collection.find as any).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            toArray: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      await request(testServer()).get(`/api/v1/requests?projectId=${TEST_PROJECT_ID}`);
      expect(mocks.collection.aggregate).not.toHaveBeenCalled();
    });

    it("passes status filter to find query", async () => {
      (mocks.collection.find as any).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            toArray: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      await request(testServer()).get(`/api/v1/requests?status=done&projectId=${TEST_PROJECT_ID}`);
      expect(mocks.collection.find).toHaveBeenCalledWith(
        expect.objectContaining({ "run.status": "done" }),
      );
    });

    it("passes outcome filter to find query", async () => {
      (mocks.collection.find as any).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            toArray: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      await request(testServer()).get(`/api/v1/requests?outcome=succeeded&projectId=${TEST_PROJECT_ID}`);
      expect(mocks.collection.find).toHaveBeenCalledWith(
        expect.objectContaining({ "run.outcome": "succeeded" }),
      );
    });

    it("passes status and outcome filters to aggregate pipeline $match", async () => {
      (mocks.collection.aggregate as any)
        .mockReturnValueOnce({ toArray: vi.fn().mockResolvedValue([]) })
        .mockReturnValueOnce({ toArray: vi.fn().mockResolvedValue([{ count: 0 }]) });

      await request(testServer()).get(`/api/v1/requests?groupBy=task&status=done&outcome=failed&projectId=${TEST_PROJECT_ID}`);
      const pipeline = (mocks.collection.aggregate as any).mock.calls[0][0];
      expect(pipeline[0]).toEqual(
        expect.objectContaining({
          $match: expect.objectContaining({ "run.status": "done", "run.outcome": "failed" }),
        }),
      );
    });

    it("combines status, outcome, and worker filters", async () => {
      (mocks.collection.find as any).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            toArray: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      await request(testServer()).get(`/api/v1/requests?status=processing&outcome=succeeded&worker=coder-acp-copilot&projectId=${TEST_PROJECT_ID}`);
      expect(mocks.collection.find).toHaveBeenCalledWith(
        expect.objectContaining({
          "run.status": "processing",
          "run.outcome": "succeeded",
          workerType: "coder-acp-copilot",
        }),
      );
    });

    // ── #1138: server-side multi-value / sentinel / search / new dimensions ──

    /** Mock the find().sort().limit().toArray() chain; returns the sort spy. */
    const mockFindChain = (docs: any[] = []) => {
      const sortSpy = vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue(docs) }),
      });
      (mocks.collection.find as any).mockReturnValue({ sort: sortSpy });
      return sortSpy;
    };

    it("turns a multi-value status into an $in clause", async () => {
      mockFindChain();
      await request(testServer()).get(`/api/v1/requests?status=done&status=pending&projectId=${TEST_PROJECT_ID}`);
      expect(mocks.collection.find).toHaveBeenCalledWith(
        expect.objectContaining({ "run.status": { $in: ["done", "pending"] } }),
      );
    });

    it("accepts comma-separated multi-value selections", async () => {
      mockFindChain();
      await request(testServer()).get(`/api/v1/requests?outcome=succeeded,failed&projectId=${TEST_PROJECT_ID}`);
      expect(mocks.collection.find).toHaveBeenCalledWith(
        expect.objectContaining({ "run.outcome": { $in: ["succeeded", "failed"] } }),
      );
    });

    it("maps the (Unknown) sentinel to a missing-or-null $and clause", async () => {
      mockFindChain();
      await request(testServer()).get(`/api/v1/requests?outcome=__empty__&projectId=${TEST_PROJECT_ID}`);
      const filter = (mocks.collection.find as any).mock.calls.at(-1)[0];
      expect(filter.$and).toEqual(
        expect.arrayContaining([
          { $or: [{ "run.outcome": { $exists: false } }, { "run.outcome": null }] },
        ]),
      );
    });

    it("adds a case-insensitive regex $or for free-text search", async () => {
      mockFindChain();
      await request(testServer()).get(`/api/v1/requests?search=gpt-5&projectId=${TEST_PROJECT_ID}`);
      const filter = (mocks.collection.find as any).mock.calls.at(-1)[0];
      const searchClause = (filter.$and as any[]).find((c) => Array.isArray(c.$or) && c.$or.some((o: any) => o.model));
      expect(searchClause).toBeDefined();
      expect(searchClause.$or).toEqual(
        expect.arrayContaining([{ model: { $regex: "gpt-5", $options: "i" } }]),
      );
    });

    it("filters by model, os, and agentVersion", async () => {
      mockFindChain();
      await request(testServer()).get(
        `/api/v1/requests?model=gpt-5&os=linux&agentVersion=copilot-0.0.415&projectId=${TEST_PROJECT_ID}`,
      );
      expect(mocks.collection.find).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "gpt-5",
          "run.os.platform": "linux",
          agentVersion: "copilot-0.0.415",
        }),
      );
    });

    it("coerces a priority filter to a number", async () => {
      mockFindChain();
      await request(testServer()).get(`/api/v1/requests?priority=3&projectId=${TEST_PROJECT_ID}`);
      expect(mocks.collection.find).toHaveBeenCalledWith(
        expect.objectContaining({ priority: 3 }),
      );
    });

    it("applies a createdAt range for createdAfter/createdBefore", async () => {
      mockFindChain();
      await request(testServer()).get(
        `/api/v1/requests?createdAfter=2026-01-01T00:00:00Z&createdBefore=2026-12-31T00:00:00Z&projectId=${TEST_PROJECT_ID}`,
      );
      const filter = (mocks.collection.find as any).mock.calls.at(-1)[0];
      expect(filter.createdAt.$gte).toBeInstanceOf(Date);
      expect(filter.createdAt.$lte).toBeInstanceOf(Date);
    });

    it("rejects an inverted createdAt range with 400", async () => {
      mockFindChain();
      const res = await request(testServer()).get(
        `/api/v1/requests?createdAfter=2026-12-31T00:00:00Z&createdBefore=2026-01-01T00:00:00Z&projectId=${TEST_PROJECT_ID}`,
      );
      expect(res.status).toBe(400);
    });

    it("rejects an invalid createdAfter datetime with 400", async () => {
      mockFindChain();
      const res = await request(testServer()).get(`/api/v1/requests?createdAfter=not-a-date&projectId=${TEST_PROJECT_ID}`);
      expect(res.status).toBe(400);
    });

    it("sorts by an allowlisted field and direction over { field, _id }", async () => {
      const sortSpy = mockFindChain();
      await request(testServer()).get(`/api/v1/requests?sortBy=priority&sortDir=asc&projectId=${TEST_PROJECT_ID}`);
      expect(sortSpy).toHaveBeenCalledWith({ priority: 1, _id: 1 });
    });

    it("defaults to createdAt desc when no sortBy is given", async () => {
      const sortSpy = mockFindChain();
      await request(testServer()).get(`/api/v1/requests?projectId=${TEST_PROJECT_ID}`);
      expect(sortSpy).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
    });

    it("returns an accurate countDocuments total when a filter is active", async () => {
      mockFindChain();
      (mocks.collection.countDocuments as any).mockResolvedValue(7);
      (mocks.collection.estimatedDocumentCount as any).mockResolvedValue(99);
      const res = await request(testServer()).get(`/api/v1/requests?status=done&projectId=${TEST_PROJECT_ID}`);
      expect(res.body.estimatedTotal).toBe(7);
      expect(mocks.collection.countDocuments).toHaveBeenCalled();
    });

    it("uses the O(1) estimate when no filter is active", async () => {
      mockFindChain();
      (mocks.collection.countDocuments as any).mockResolvedValue(7);
      (mocks.collection.estimatedDocumentCount as any).mockResolvedValue(99);
      const res = await request(testServer()).get(`/api/v1/requests?projectId=${TEST_PROJECT_ID}`);
      expect(res.body.estimatedTotal).toBe(7);
      expect(mocks.collection.countDocuments).toHaveBeenCalled();
    });

    it("omits estimatedTotal and skips run-count queries in grouped mode", async () => {
      // Grouped mode is paginated by group cursors, not a run count — the API
      // must not return estimatedTotal nor run countDocuments/estimatedDocumentCount.
      (mocks.collection.aggregate as any)
        .mockReturnValueOnce({ toArray: vi.fn().mockResolvedValue([{ _id: "tp-1" }]) }) // keys
        .mockReturnValueOnce({ toArray: vi.fn().mockResolvedValue([{ key: "tp-1", aggregates: { count: 1 }, uniform: {} }]) }) // phase2
        .mockReturnValueOnce({ toArray: vi.fn().mockResolvedValue([]) }) // hasMoreAfter
        .mockReturnValueOnce({ toArray: vi.fn().mockResolvedValue([]) }); // hasMoreBefore
      (mocks.collection.countDocuments as any).mockResolvedValue(7);
      (mocks.collection.estimatedDocumentCount as any).mockResolvedValue(99);

      const res = await request(testServer()).get(`/api/v1/requests?groupBy=task&projectId=${TEST_PROJECT_ID}`);
      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty("estimatedTotal");
      expect(mocks.collection.countDocuments).not.toHaveBeenCalled();
      expect(mocks.collection.estimatedDocumentCount).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/v1/requests/facets", () => {
    it("returns absolute per-dimension counts with a derived total", async () => {
      (mocks.collection.aggregate as any).mockReturnValue({
        toArray: vi.fn().mockResolvedValue([
          { _id: "coder-acp-copilot", count: 8 },
          { _id: null, count: 4 },
        ]),
      });

      const res = await request(testServer()).get(`/api/v1/requests/facets?projectId=${TEST_PROJECT_ID}`);
      expect(res.status).toBe(200);
      // total is derived by summing a single dimension's buckets (8 + 4), not a
      // separate count query.
      expect(res.body.total).toBe(12);
      expect(mocks.collection.countDocuments as any).not.toHaveBeenCalled();
      expect(mocks.collection.estimatedDocumentCount as any).not.toHaveBeenCalled();
      expect(res.body.facets).toHaveProperty("workerType");
      expect(res.body.facets).toHaveProperty("status");
      expect(res.body.facets).toHaveProperty("outcome");
      expect(res.body.facets).toHaveProperty("model");
      expect(res.body.facets).toHaveProperty("os");
      expect(res.body.facets).toHaveProperty("priority");
      expect(res.body.facets).toHaveProperty("agentVersion");
      expect(res.body.facets).toHaveProperty("profileId");
      // null _id buckets map to the (Unknown) sentinel; rows sort by count desc.
      expect(res.body.facets.workerType).toEqual([
        { value: "coder-acp-copilot", count: 8 },
        { value: "__empty__", count: 4 },
      ]);
    });

    it("runs one $group aggregation per categorical dimension", async () => {
      (mocks.collection.aggregate as any).mockReturnValue({
        toArray: vi.fn().mockResolvedValue([]),
      });

      await request(testServer()).get(`/api/v1/requests/facets?projectId=${TEST_PROJECT_ID}`);
      // 8 categorical dimensions → 8 parallel aggregations (no $facet).
      expect((mocks.collection.aggregate as any).mock.calls.length).toBe(8);
    });

    it("ignores search, date, iteration, and categorical query params (absolute counts)", async () => {
      (mocks.collection.aggregate as any).mockReturnValue({
        toArray: vi.fn().mockResolvedValue([]),
      });

      await request(testServer()).get(
        `/api/v1/requests/facets?search=foo&status=done&model=gpt-4&createdAfter=2024-01-01T00:00:00Z&turns=3&turnsOp=gte&projectId=${TEST_PROJECT_ID}`,
      );
      // Every aggregation matches only the constant non-deleted predicate; no
      // search regex / date / numeric / categorical clause leaks into $match.
      const calls = (mocks.collection.aggregate as any).mock.calls;
      expect(calls.length).toBe(8);
      for (const [pipeline] of calls) {
        expect(pipeline[0]).toEqual({
          $match: { deletedAt: { $exists: false }, projectId: TEST_PROJECT_ID },
        });
      }
    });

    it("serves repeated requests from a single cached computation", async () => {
      (mocks.collection.aggregate as any).mockReturnValue({
        toArray: vi.fn().mockResolvedValue([{ _id: "x", count: 1 }]),
      });

      const first = await request(testServer()).get(`/api/v1/requests/facets?projectId=${TEST_PROJECT_ID}`);
      const second = await request(testServer()).get(`/api/v1/requests/facets?projectId=${TEST_PROJECT_ID}`);
      expect(first.status).toBe(200);
      expect(second.body).toEqual(first.body);
      // Second call hits the in-memory cache → no additional aggregations.
      expect((mocks.collection.aggregate as any).mock.calls.length).toBe(8);
    });
  });

  describe("GET /api/v1/requests/:id", () => {
    it("returns 200 when request exists", async () => {
      const doc = { _id: "r1", scenario: { task: "t", criteria: [] }, workerType: "coder-acp-copilot", status: "completed" };
      (mocks.collection.findOne as any).mockResolvedValue(doc);

      const res = await request(testServer()).get("/api/v1/requests/r1");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("id", "r1");
    });

    it("returns 404 when request not found", async () => {
      (mocks.collection.findOne as any).mockResolvedValue(null);

      const res = await request(testServer()).get("/api/v1/requests/missing");
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/v1/requests/:id", () => {
    it("returns 200 when request is soft-deleted", async () => {
      (mocks.collection.updateOne as any).mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });

      const res = await request(testServer()).delete("/api/v1/requests/r1");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("deleted", true);
    });

    it("returns 404 when request not found", async () => {
      (mocks.collection.updateOne as any).mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
      (mocks.collection.findOne as any).mockResolvedValue(null);

      const res = await request(testServer()).delete("/api/v1/requests/missing");
      expect(res.status).toBe(404);
    });

    it("returns 410 when request already deleted", async () => {
      (mocks.collection.updateOne as any).mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
      (mocks.collection.findOne as any).mockResolvedValue({ _id: "r1", deletedAt: new Date() });

      const res = await request(testServer()).delete("/api/v1/requests/r1");
      expect(res.status).toBe(410);
    });
  });

  // ===================================================================
  // Reports endpoints
  // ===================================================================

  describe("GET /api/v1/reports", () => {
    it("returns 200 with array of reports", async () => {
      const reports = [{ _id: "rp1", requestId: "r1", status: "completed", createdAt: new Date() }];
      (mocks.reportCollection.find as any).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue(reports),
        }),
      });
      // For run task enrichment
      (mocks.collection.find as any).mockReturnValue({
        toArray: vi.fn().mockResolvedValue([]),
      });

      const res = await request(testServer()).get(`/api/v1/reports?projectId=${TEST_PROJECT_ID}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe("POST /api/v1/reports", () => {
    it("returns 201 when creating a report", async () => {
      // Run exists
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "r1",
        status: "completed",
      });

      const res = await request(testServer())
        .post("/api/v1/reports")
        .send({ requestId: "r1" });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("requestId", "r1");
      expect(res.body).toHaveProperty("status", "pending");
    });

    it("returns 400 when requestId missing", async () => {
      const res = await request(testServer())
        .post("/api/v1/reports")
        .send({});

      expect(res.status).toBe(400);
    });

    it("returns 404 when referenced run not found", async () => {
      (mocks.collection.findOne as any).mockResolvedValue(null);

      const res = await request(testServer())
        .post("/api/v1/reports")
        .send({ requestId: "no-such-run" });

      expect(res.status).toBe(404);
    });
  });

  // ===================================================================
  // Report Templates endpoints
  // ===================================================================

  describe("GET /api/v1/report-templates", () => {
    it("returns 200 with array of report templates", async () => {
      const templates = [{ id: "rt1", name: "Default", userPrompt: "Analyze", createdAt: new Date() }];
      (mocks.reportTemplateCollection.find as any).mockReturnValue({
        toArray: vi.fn().mockResolvedValue(templates),
      });

      const res = await request(testServer()).get(`/api/v1/report-templates?projectId=${TEST_PROJECT_ID}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  // §16: report-templates is project-scoped; by-id GET/PUT/DELETE must never
  // resolve a business `id` globally — they require ?projectId= and scope the
  // Mongo filter to { projectId, id } (never a global slug-only { id }).
  describe("Report templates by-id scoping (§16)", () => {
    const TID = "rt-scope";
    const seededTemplate = {
      projectId: TEST_PROJECT_ID,
      id: TID,
      name: "Seed",
      userPrompt: "Analyze",
      createdAt: new Date(),
    };

    it("GET /:id without projectId → 400 (no global slug-only resolve)", async () => {
      const res = await request(testServer()).get(`/api/v1/report-templates/${TID}`);
      expect(res.status).toBe(400);
      expect(mocks.reportTemplateCollection.findOne).not.toHaveBeenCalled();
    });

    it("GET /:id?projectId scopes the read to { projectId, id }", async () => {
      (mocks.reportTemplateCollection.findOne as any).mockResolvedValue(seededTemplate);
      const res = await request(testServer()).get(`/api/v1/report-templates/${TID}?projectId=${TEST_PROJECT_ID}`);
      expect(res.status).toBe(200);
      expect(mocks.reportTemplateCollection.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: TEST_PROJECT_ID, id: TID })
      );
    });

    it("PUT /:id without projectId → 400 (never a global slug-only update)", async () => {
      const res = await request(testServer()).put(`/api/v1/report-templates/${TID}`).send({ name: "x" });
      expect(res.status).toBe(400);
      expect(mocks.reportTemplateCollection.updateOne).not.toHaveBeenCalled();
    });

    it("PUT /:id?projectId scopes both the existence check and the update to { projectId, id }", async () => {
      (mocks.reportTemplateCollection.findOne as any).mockResolvedValue(seededTemplate);
      const res = await request(testServer())
        .put(`/api/v1/report-templates/${TID}?projectId=${TEST_PROJECT_ID}`)
        .send({ name: "Renamed" });
      expect(res.status).toBe(200);
      expect(mocks.reportTemplateCollection.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: TEST_PROJECT_ID, id: TID })
      );
      expect(mocks.reportTemplateCollection.updateOne).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: TEST_PROJECT_ID, id: TID }),
        expect.anything()
      );
    });

    it("DELETE /:id without projectId → 400 (never a global slug-only soft-delete)", async () => {
      const res = await request(testServer()).delete(`/api/v1/report-templates/${TID}`);
      expect(res.status).toBe(400);
      expect(mocks.reportTemplateCollection.updateOne).not.toHaveBeenCalled();
    });

    it("DELETE /:id?projectId soft-deletes scoped to { projectId, id }", async () => {
      (mocks.reportTemplateCollection.findOne as any).mockResolvedValue(seededTemplate);
      const res = await request(testServer()).delete(`/api/v1/report-templates/${TID}?projectId=${TEST_PROJECT_ID}`);
      expect(res.status).toBe(204);
      expect(mocks.reportTemplateCollection.updateOne).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: TEST_PROJECT_ID, id: TID }),
        expect.objectContaining({ $set: expect.objectContaining({ deletedAt: expect.anything() }) })
      );
    });
  });

  // ===================================================================
  // Feature Flags endpoints
  // ===================================================================

  describe("GET /api/v1/feature-flags", () => {
    it("returns 200 with array of feature flags", async () => {
      const flags = [{ key: "mcp", label: "MCP", enabled: true }];
      (mocks.featureFlagCollection.find as any).mockReturnValue({
        toArray: vi.fn().mockResolvedValue(flags),
      });

      const res = await request(testServer()).get("/api/v1/feature-flags");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  // ===================================================================
  // Skills endpoints
  // ===================================================================

  describe("GET /api/v1/skills", () => {
    it("returns 200 with array of skills", async () => {
      const skills = [{ _id: "org/repo/skill", name: "My Skill", source: "org/repo", skillName: "skill", createdAt: new Date() }];
      (mocks.skillCollection.find as any).mockReturnValue({
        toArray: vi.fn().mockResolvedValue(skills),
      });

      const res = await request(testServer()).get(`/api/v1/skills?projectId=${TEST_PROJECT_ID}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0]).toHaveProperty("id", "org/repo/skill");
    });
  });

  describe("POST /api/v1/skills (auto-resolve)", () => {
    it("creates a skill and triggers auto-resolve from GitHub", async () => {
      (mocks.skillCollection.findOne as any).mockResolvedValue(null);
      (mocks.skillCollection.insertOne as any).mockResolvedValue({ acknowledged: true });
      (mocks.skillResolver.resolve as any).mockResolvedValue({ ref: "mock-ref" });

      const res = await request(testServer())
        .post(`/api/v1/skills?projectId=${TEST_PROJECT_ID}`)
        .send({ source: "org/repo", skillName: "my-skill", name: "My Skill", origin: "manual" });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id", "org/repo/my-skill");
      expect(mocks.skillResolver.resolve).toHaveBeenCalledOnce();
      expect(mocks.skillResolver.resolve).toHaveBeenCalledWith(
        TEST_PROJECT_ID,
        "org/repo",
        "my-skill",
        mocks.skillRevisionStore,
        expect.any(Function),
      );
    });

    it("still returns the created skill when auto-resolve fails", async () => {
      (mocks.skillCollection.findOne as any).mockResolvedValue(null);
      (mocks.skillCollection.insertOne as any).mockResolvedValue({ acknowledged: true });
      (mocks.skillResolver.resolve as any).mockRejectedValue(new Error("GitHub 404"));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const res = await request(testServer())
        .post(`/api/v1/skills?projectId=${TEST_PROJECT_ID}`)
        .send({ source: "org/repo", skillName: "missing-skill", name: "Missing", origin: "manual" });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id", "org/repo/missing-skill");
      expect(mocks.skillResolver.resolve).toHaveBeenCalledOnce();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Auto-resolve failed for skill org/repo/missing-skill"),
      );
      warnSpy.mockRestore();
    });

    it("auto-resolves on upsert of an existing skill", async () => {
      const existing = {
        _id: "org/repo/my-skill",
        source: "org/repo",
        skillName: "my-skill",
        name: "Old Name",
        origin: "manual",
        createdAt: new Date(),
      };
      (mocks.skillCollection.findOne as any)
        .mockResolvedValueOnce(existing)
        .mockResolvedValueOnce({ ...existing, name: "New Name" });
      (mocks.skillCollection.updateOne as any).mockResolvedValue({ acknowledged: true });
      (mocks.skillResolver.resolve as any).mockResolvedValue({ ref: "mock-ref" });

      const res = await request(testServer())
        .post(`/api/v1/skills?projectId=${TEST_PROJECT_ID}`)
        .send({ source: "org/repo", skillName: "my-skill", name: "New Name", origin: "manual" });

      expect(res.status).toBe(200);
      expect(mocks.skillResolver.resolve).toHaveBeenCalledOnce();
    });
  });

  describe("GET /api/v1/skills/discover", () => {
    it("returns 400 when source query parameter is missing", async () => {
      const res = await request(testServer()).get(`/api/v1/skills/discover?projectId=${TEST_PROJECT_ID}`);
      expect(res.status).toBe(400);
    });

    it("returns 400 when source is malformed", async () => {
      const res = await request(testServer()).get(`/api/v1/skills/discover?source=not-a-repo&projectId=${TEST_PROJECT_ID}`);
      expect(res.status).toBe(400);
    });

    it("returns 200 with the list of discovered skills", async () => {
      const discovered = [
        { skillName: "vector-search", skillPath: "skills/vector-search", name: "Vector Search", description: "Embeddings" },
        { skillName: "indexing", skillPath: "skills/indexing" },
      ];
      mocks.skillResolver.discoverSkills = vi.fn().mockResolvedValue(discovered);

      const res = await request(testServer()).get(`/api/v1/skills/discover?source=Azure/documentdb-agent-kit&projectId=${TEST_PROJECT_ID}`);
      expect(res.status).toBe(200);
      // Route enriches each result with library state. With an empty skill
      // collection, every discovered skill is reported as new.
      expect(res.body).toEqual(discovered.map((d) => ({ ...d, existsInLibrary: false })));
      expect(mocks.skillResolver.discoverSkills).toHaveBeenCalledWith("Azure/documentdb-agent-kit");
    });

    it("returns 404 when the repository is not found", async () => {
      mocks.skillResolver.discoverSkills = vi.fn().mockRejectedValue(new Error('Repository "owner/missing" not found'));

      const res = await request(testServer()).get(`/api/v1/skills/discover?source=owner/missing&projectId=${TEST_PROJECT_ID}`);
      expect(res.status).toBe(404);
    });

    it("returns 502 on other GitHub errors", async () => {
      mocks.skillResolver.discoverSkills = vi.fn().mockRejectedValue(new Error("rate limit exceeded"));

      const res = await request(testServer()).get(`/api/v1/skills/discover?source=owner/repo&projectId=${TEST_PROJECT_ID}`);
      expect(res.status).toBe(502);
    });
  });

  // ===================================================================
  // Prompt Features endpoints
  // ===================================================================

  describe("GET /api/v1/prompt-features", () => {
    it("returns 200 with array of prompt features", async () => {
      const features = [{ id: "pf1", prompt: "Does X?", createdAt: new Date() }];
      (mocks.promptFeatureCollection.find as any).mockReturnValue({
        toArray: vi.fn().mockResolvedValue(features),
      });

      const res = await request(testServer()).get(`/api/v1/prompt-features?projectId=${TEST_PROJECT_ID}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe("POST /api/v1/prompt-features", () => {
    it("returns 201 when creating a prompt feature", async () => {
      (mocks.promptFeatureCollection.findOne as any).mockResolvedValue(null);

      const res = await request(testServer())
        .post(`/api/v1/prompt-features?projectId=${TEST_PROJECT_ID}`)
        .send({ id: "new_feature", prompt: "Does it have X?" });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id", "new_feature");
    });

    it("returns 400 when id has invalid format", async () => {
      const res = await request(testServer())
        .post(`/api/v1/prompt-features?projectId=${TEST_PROJECT_ID}`)
        .send({ id: "Invalid-ID", prompt: "Bad id" });

      expect(res.status).toBe(400);
    });

    it("persists type=agents.md when creating a feature", async () => {
      (mocks.promptFeatureCollection.findOne as any).mockResolvedValue(null);

      const res = await request(testServer())
        .post(`/api/v1/prompt-features?projectId=${TEST_PROJECT_ID}`)
        .send({ id: "agents_feat", prompt: "Does AGENTS.md mention tests?", type: "agents.md" });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("type", "agents.md");
      const doc = (mocks.promptFeatureCollection.insertOne as any).mock.calls[0][0];
      expect(doc).toHaveProperty("type", "agents.md");
    });
  });

  describe("GET /api/v1/prompt-features?type=", () => {
    it("scopes the query to agents.md features", async () => {
      (mocks.promptFeatureCollection.find as any).mockReturnValue({
        toArray: vi.fn().mockResolvedValue([]),
      });

      const res = await request(testServer()).get(`/api/v1/prompt-features?type=agents.md&projectId=${TEST_PROJECT_ID}`);
      expect(res.status).toBe(200);
      const filter = (mocks.promptFeatureCollection.find as any).mock.calls[0][0];
      expect(JSON.stringify(filter)).toContain("agents.md");
    });

    it("treats select type as including legacy untyped features", async () => {
      (mocks.promptFeatureCollection.find as any).mockReturnValue({
        toArray: vi.fn().mockResolvedValue([]),
      });

      await request(testServer()).get(`/api/v1/prompt-features?type=select&projectId=${TEST_PROJECT_ID}`);
      const filter = (mocks.promptFeatureCollection.find as any).mock.calls[0][0];
      const json = JSON.stringify(filter);
      expect(json).toContain("$exists");
      expect(json).toContain("select");
    });
  });

  describe("GET /api/v1/prompt-features/:id", () => {
    it("returns 200 when prompt feature exists", async () => {
      (mocks.promptFeatureCollection.findOne as any).mockResolvedValue({
        id: "pf1",
        prompt: "Check X",
        createdAt: new Date(),
      });

      const res = await request(testServer()).get(`/api/v1/prompt-features/pf1?projectId=${TEST_PROJECT_ID}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("id", "pf1");
    });

    it("returns 404 when prompt feature not found", async () => {
      (mocks.promptFeatureCollection.findOne as any).mockResolvedValue(null);

      const res = await request(testServer()).get(`/api/v1/prompt-features/missing?projectId=${TEST_PROJECT_ID}`);
      expect(res.status).toBe(404);
    });
  });

  // ===================================================================
  // Task Prompts endpoints
  // ===================================================================

  describe("GET /api/v1/task-prompts", () => {
    it("returns 200 with paginated task prompts", async () => {
      (mocks.taskPromptStore as any).getAll.mockResolvedValue({
        items: [{ _id: "tp1", text: "Build a form", createdAt: new Date() }],
        total: 1,
      });

      const res = await request(testServer()).get(`/api/v1/task-prompts?projectId=${TEST_PROJECT_ID}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("items");
      expect(res.body).toHaveProperty("total", 1);
    });
  });

  describe("GET /api/v1/task-prompts/:id", () => {
    it("returns 200 when task prompt exists", async () => {
      (mocks.taskPromptStore as any).get.mockResolvedValue({
        _id: "tp1",
        text: "Build a form",
        createdAt: new Date(),
      });

      const res = await request(testServer()).get("/api/v1/task-prompts/tp1");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("_id", "tp1");
    });

    it("returns 404 when task prompt not found", async () => {
      (mocks.taskPromptStore as any).get.mockResolvedValue(null);

      const res = await request(testServer()).get("/api/v1/task-prompts/missing");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/v1/task-prompts", () => {
    it("returns 201 when creating a task prompt", async () => {
      (mocks.taskPromptStore as any).findOrCreate.mockResolvedValue({
        _id: "tp-new",
        text: "New task",
        createdAt: new Date(),
      });

      const res = await request(testServer())
        .post(`/api/v1/task-prompts?projectId=${TEST_PROJECT_ID}`)
        .send({ text: "New task" });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("text", "New task");
    });

    it("returns 400 when text is missing", async () => {
      const res = await request(testServer())
        .post(`/api/v1/task-prompts?projectId=${TEST_PROJECT_ID}`)
        .send({});

      expect(res.status).toBe(400);
    });
  });

  // ===================================================================
  // Typed task prompts (task | agents.md) + content resolution
  // ===================================================================

  describe("Typed task prompts", () => {
    it("passes ?type=agents.md through to the store getAll filter", async () => {
      (mocks.taskPromptStore as any).getAll.mockResolvedValue({ items: [], total: 0 });

      const res = await request(testServer()).get(`/api/v1/task-prompts?type=agents.md&projectId=${TEST_PROJECT_ID}`);
      expect(res.status).toBe(200);
      const arg = (mocks.taskPromptStore.getAll as any).mock.calls[0][0];
      expect(arg).toHaveProperty("type", "agents.md");
    });

    it("creates a prompt with type=agents.md", async () => {
      (mocks.taskPromptStore as any).findOrCreate.mockResolvedValue({
        _id: "agents-1",
        type: "agents.md",
        text: "# AGENTS\nBe concise.",
        createdAt: new Date(),
      });

      const res = await request(testServer())
        .post(`/api/v1/task-prompts?projectId=${TEST_PROJECT_ID}`)
        .send({ text: "# AGENTS\nBe concise.", type: "agents.md" });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("type", "agents.md");
      const arg = (mocks.taskPromptStore.findOrCreate as any).mock.calls[0];
      expect(arg[0]).toBe(TEST_PROJECT_ID);
      expect(arg[1]).toBe("# AGENTS\nBe concise.");
      expect(arg[2]).toBe("agents.md");
    });

    it("GET /:id/content resolves the prompt body via resolvePromptText", async () => {
      (mocks.taskPromptStore as any).get.mockResolvedValue({
        _id: "agents-1",
        type: "agents.md",
        contentBlobUrl: "https://blob/prompts/agents-1.txt",
        createdAt: new Date(),
      });
      (mocks.taskPromptStore as any).resolvePromptText.mockResolvedValue("resolved body");

      const res = await request(testServer()).get("/api/v1/task-prompts/agents-1/content");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: "agents-1", text: "resolved body" });
      expect(mocks.taskPromptStore.resolvePromptText).toHaveBeenCalled();
    });

    it("GET /:id/content returns 404 when the prompt does not exist", async () => {
      (mocks.taskPromptStore as any).get.mockResolvedValue(null);

      const res = await request(testServer()).get("/api/v1/task-prompts/missing/content");
      expect(res.status).toBe(404);
    });
  });

  // ===================================================================
  // Submit with profile — server-side field resolution
  // ===================================================================

  describe("POST /api/v1/requests?worker=... (profile)", () => {
    const resourceRevision = {
      _id: "rev-github-simulator-1",
      resourceId: "res-github-simulator",
      projectId: TEST_PROJECT_ID,
      slug: "github-simulator",
      revisionNumber: 1,
      ref: "github-simulator@r1",
      setup: { sh: "echo SIMULATOR_URL=http://sim >> $SCOPE_SETUP_ENV" },
      exports: ["SIMULATOR_URL"],
      parameters: [
        { name: "REPO", required: true },
        { name: "AS", required: false },
      ],
      contentSha256: "sha",
      createdAt: new Date(),
    };

    function mockGithubSimulatorResource() {
      (mocks.resourceStore.getBySlug as any).mockResolvedValue({
        _id: "res-github-simulator",
        projectId: TEST_PROJECT_ID,
        slug: "github-simulator",
        name: "GitHub Simulator",
        revisionCounter: 1,
        latestRevisionId: resourceRevision._id,
        latestRevisionNumber: 1,
        createdAt: new Date(),
      });
      (mocks.resourceRevisionStore.getLatest as any).mockResolvedValue(resourceRevision);
    }

    it("applies profile fields server-side, ignoring client-omitted fields", async () => {
      (mocks.profileCollection.findOne as any).mockResolvedValue({
        _id: "profile-1",
        name: "My Profile",
        latestVersion: 1,
      });
      (mocks.profileVersionCollection.findOne as any).mockResolvedValue({
        _id: "pv-1",
        profileId: "profile-1",
        version: 1,
        workerType: "coder-acp-copilot",
        agentVersion: "v1",
        model: "claude-sonnet-4",
        mcpServers: ["ms-learn"],
        skillRevisions: ["github/awesome-copilot/cosmosdb@abc123"],
        extensions: [],
      });
      (mocks.agentCollection.findOne as any).mockResolvedValue({
        _id: "coder-acp-copilot",
        available: true,
        versions: [
          { agentVersion: "v1", status: "active", queueName: "queue-coder-acp-copilot-v1", createdAt: new Date("2026-01-01") },
          { agentVersion: "v2", status: "active", queueName: "queue-coder-acp-copilot-v2", createdAt: new Date("2026-02-01") },
        ],
        supportedModels: ["claude-sonnet-4"],
      });
      // resolveSkillSpecs will validate the skill slug exists
      (mocks.skillCollection.find as any).mockReturnValue({
        toArray: vi.fn().mockResolvedValue([{ _id: "github/awesome-copilot/cosmosdb" }]),
      });
      // Mock the skill revision store getByRef
      (mocks.skillRevisionStore.getByRef as any).mockResolvedValue({
        _id: "rev-1",
        ref: "github/awesome-copilot/cosmosdb@abc123",
      });
      // Mock MCP server validation (ms-learn exists)
      (mocks.mcpServerCollection.find as any).mockReturnValue({
        toArray: vi.fn().mockResolvedValue([{ _id: "ms-learn" }]),
      });

      const res = await request(testServer())
        .post(`/api/v1/requests?worker=coder-acp-copilot&projectId=${TEST_PROJECT_ID}`)
        .send({
          scenario: { task: "Build something", criteria: ["works"] },
          profileId: "profile-1",
          agentVersion: "v2",
          // Client omits model, mcpServers, skills, extensions — profile provides them
        });

      expect(res.status).toBe(201);
      const doc = (mocks.collection.insertOne as any).mock.calls[0][0];
      expect(doc).toHaveProperty("model", "claude-sonnet-4");
      expect(doc).toHaveProperty("mcpServers", ["ms-learn"]);
      expect(doc).toHaveProperty("skillRevisions", ["github/awesome-copilot/cosmosdb@abc123"]);
      expect(doc).toHaveProperty("profileId", "profile-1");
      expect(doc).toHaveProperty("profileVersionId", "pv-1");
      expect(doc).toHaveProperty("agentVersion", "v1");
    });

    it("returns 400 when client sends fields conflicting with profile", async () => {
      (mocks.profileCollection.findOne as any).mockResolvedValue({
        _id: "profile-1",
        name: "My Profile",
        latestVersion: 1,
      });
      (mocks.profileVersionCollection.findOne as any).mockResolvedValue({
        _id: "pv-1",
        profileId: "profile-1",
        version: 1,
        workerType: "coder-acp-copilot",
        model: "claude-sonnet-4",
        mcpServers: [],
        skillRevisions: [],
        extensions: [],
      });

      const res = await request(testServer())
        .post(`/api/v1/requests?worker=coder-acp-copilot&projectId=${TEST_PROJECT_ID}`)
        .send({
          scenario: { task: "Build something", criteria: ["works"] },
          profileId: "profile-1",
          model: "gpt-4o", // conflicts with profile's claude-sonnet-4
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("controls these fields");
      expect(res.body.conflicts).toEqual(
        expect.arrayContaining([expect.stringContaining("model")])
      );
    });

    it("rejects an MCP slug that belongs to another project (project-scoped validation)", async () => {
      (mocks.profileCollection.findOne as any).mockResolvedValue({
        _id: "profile-1",
        name: "My Profile",
        latestVersion: 1,
      });
      (mocks.profileVersionCollection.findOne as any).mockResolvedValue({
        _id: "pv-1",
        profileId: "profile-1",
        version: 1,
        workerType: "coder-acp-copilot",
        model: "claude-sonnet-4",
        mcpServers: ["ms-learn"], // slug exists, but only in a different project
        skillRevisions: [],
        extensions: [],
      });
      (mocks.agentCollection.findOne as any).mockResolvedValue({
        _id: "coder-acp-copilot",
        available: true,
        versions: [{ agentVersion: "v1", status: "active", queueName: "queue-coder-acp-copilot", createdAt: new Date() }],
        supportedModels: ["claude-sonnet-4"],
      });
      // The project-scoped lookup finds nothing — the slug lives in another project.
      const findSpy = vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) });
      (mocks.mcpServerCollection.find as any) = findSpy;

      const res = await request(testServer())
        .post(`/api/v1/requests?worker=coder-acp-copilot&projectId=${TEST_PROJECT_ID}`)
        .send({
          scenario: { task: "Build something", criteria: ["works"] },
          profileId: "profile-1",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("MCP server(s) not found");
      expect(res.body.error).toContain("ms-learn");
      // Validation query must be scoped to the request's project.
      const filter = findSpy.mock.calls[0][0];
      expect(filter).toHaveProperty("projectId", TEST_PROJECT_ID);
    });

    it("returns 400 when a run resource param uses an unknown key", async () => {
      mockGithubSimulatorResource();

      const res = await request(testServer())
        .post(`/api/v1/requests?worker=coder-acp-copilot&projectId=${TEST_PROJECT_ID}`)
        .send({
          scenario: { task: "Build something", criteria: ["works"] },
          model: "gpt-4o",
          resources: [{ ref: "github-simulator", params: { REPO: "octo/api", REPOS: "typo/value" } }],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('unknown parameter "REPOS"');
      expect(mocks.collection.insertOne).not.toHaveBeenCalled();
    });

    it("returns 400 when a required resource param is missing", async () => {
      mockGithubSimulatorResource();

      const res = await request(testServer())
        .post(`/api/v1/requests?worker=coder-acp-copilot&projectId=${TEST_PROJECT_ID}`)
        .send({
          scenario: { task: "Build something", criteria: ["works"] },
          model: "gpt-4o",
          resources: ["github-simulator"],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('missing required parameter "REPO"');
      expect(mocks.collection.insertOne).not.toHaveBeenCalled();
    });

    it("returns 400 with the parameter when a run overrides a profile-pinned resource param", async () => {
      mockGithubSimulatorResource();
      (mocks.profileCollection.findOne as any).mockResolvedValue({
        _id: "profile-1",
        name: "My Profile",
        latestVersion: 1,
      });
      (mocks.profileVersionCollection.findOne as any).mockResolvedValue({
        _id: "pv-1",
        profileId: "profile-1",
        version: 1,
        workerType: "coder-acp-copilot",
        model: "gpt-4o",
        mcpServers: [],
        skillRevisions: [],
        resources: [{ ref: "github-simulator", params: { REPO: "pinned/repo" } }],
        extensions: [],
      });

      const res = await request(testServer())
        .post(`/api/v1/requests?worker=coder-acp-copilot&projectId=${TEST_PROJECT_ID}`)
        .send({
          scenario: { task: "Build something", criteria: ["works"] },
          profileId: "profile-1",
          resources: [{ ref: "github-simulator", params: { REPO: "run/repo" } }],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("controls these fields");
      expect(res.body.conflicts).toEqual(
        expect.arrayContaining([expect.stringContaining("resources.github-simulator@r1.REPO")])
      );
      expect(mocks.collection.insertOne).not.toHaveBeenCalled();
    });

    it("accepts a run filling a profile-unset resource param", async () => {
      mockGithubSimulatorResource();
      (mocks.profileCollection.findOne as any).mockResolvedValue({
        _id: "profile-1",
        name: "My Profile",
        latestVersion: 1,
      });
      (mocks.profileVersionCollection.findOne as any).mockResolvedValue({
        _id: "pv-1",
        profileId: "profile-1",
        version: 1,
        workerType: "coder-acp-copilot",
        model: "gpt-4o",
        mcpServers: [],
        skillRevisions: [],
        resources: [{ ref: "github-simulator", params: { AS: "pinned/ns" } }],
        extensions: [],
      });

      const res = await request(testServer())
        .post(`/api/v1/requests?worker=coder-acp-copilot&projectId=${TEST_PROJECT_ID}`)
        .send({
          scenario: { task: "Build something", criteria: ["works"] },
          profileId: "profile-1",
          resources: [{ ref: "github-simulator", params: { REPO: "run/repo" } }],
        });

      expect(res.status).toBe(201);
      const doc = (mocks.collection.insertOne as any).mock.calls[0][0];
      expect(doc.resources).toEqual([
        {
          ref: "github-simulator@r1",
          revisionId: "rev-github-simulator-1",
          params: { REPO: "run/repo", AS: "pinned/ns" },
        },
      ]);
    });
  });

  describe("POST /api/v1/requests?worker=... (reasoning effort)", () => {
    it("rejects when effort is incompatible with model capabilities", async () => {
      (mocks.agentCollection.findOne as any).mockResolvedValue({
        _id: "coder-acp-copilot",
        available: true,
        versions: [{ agentVersion: "v1", status: "active", queueName: "queue-coder-acp-copilot", createdAt: new Date() }],
        supportedModels: ["claude-opus-4.6"],
      });
      (mocks.modelCollection.findOne as any).mockResolvedValue({
        _id: "coder-acp-copilot:claude-opus-4.6",
        capabilities: { reasoningEffort: ["low", "medium", "high"] },
      });

      const res = await request(testServer())
        .post(`/api/v1/requests?worker=coder-acp-copilot&projectId=${TEST_PROJECT_ID}`)
        .send({
          scenario: { task: "Build something", criteria: ["works"] },
          model: "claude-opus-4.6",
          reasoningEffort: "ultra", // not in supported list
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("not supported by model");
      expect(res.body.supportedReasoningEfforts).toEqual(["low", "medium", "high"]);
    });

    it("accepts valid effort and stores it on the run", async () => {
      (mocks.agentCollection.findOne as any).mockResolvedValue({
        _id: "coder-acp-copilot",
        available: true,
        versions: [{ agentVersion: "v1", status: "active", queueName: "queue-coder-acp-copilot", createdAt: new Date() }],
        supportedModels: ["claude-opus-4.6"],
      });
      (mocks.modelCollection.findOne as any).mockResolvedValue({
        _id: "coder-acp-copilot:claude-opus-4.6",
        capabilities: { reasoningEffort: ["low", "medium", "high"] },
      });

      const res = await request(testServer())
        .post(`/api/v1/requests?worker=coder-acp-copilot&projectId=${TEST_PROJECT_ID}`)
        .send({
          scenario: { task: "Build something", criteria: ["works"] },
          model: "claude-opus-4.6",
          reasoningEffort: "high",
        });

      expect(res.status).toBe(201);
      const doc = (mocks.collection.insertOne as any).mock.calls[0][0];
      expect(doc).toHaveProperty("reasoningEffort", "high");
    });

    it("profile reasoningEffort takes precedence over client-provided effort", async () => {
      (mocks.profileCollection.findOne as any).mockResolvedValue({
        _id: "profile-1",
        name: "My Profile",
        latestVersion: 1,
      });
      (mocks.profileVersionCollection.findOne as any).mockResolvedValue({
        _id: "pv-1",
        profileId: "profile-1",
        version: 1,
        workerType: "coder-acp-copilot",
        model: "claude-opus-4.6",
        reasoningEffort: "low",
        mcpServers: [],
        skillRevisions: [],
        extensions: [],
      });
      (mocks.agentCollection.findOne as any).mockResolvedValue({
        _id: "coder-acp-copilot",
        available: true,
        versions: [{ agentVersion: "v1", status: "active", queueName: "queue-coder-acp-copilot", createdAt: new Date() }],
        supportedModels: ["claude-opus-4.6"],
      });
      (mocks.modelCollection.findOne as any).mockResolvedValue({
        _id: "coder-acp-copilot:claude-opus-4.6",
        capabilities: { reasoningEffort: ["low", "medium", "high"] },
      });

      const res = await request(testServer())
        .post(`/api/v1/requests?worker=coder-acp-copilot&projectId=${TEST_PROJECT_ID}`)
        .send({
          scenario: { task: "Build something", criteria: ["works"] },
          profileId: "profile-1",
          // Client does not send reasoningEffort; profile has "low"
        });

      expect(res.status).toBe(201);
      const doc = (mocks.collection.insertOne as any).mock.calls[0][0];
      expect(doc).toHaveProperty("reasoningEffort", "low");
    });

    it("returns warnings for models with limited effort support when no effort is specified", async () => {
      (mocks.agentCollection.findOne as any).mockResolvedValue({
        _id: "coder-acp-copilot",
        available: true,
        versions: [{ agentVersion: "v1", status: "active", queueName: "queue-coder-acp-copilot", createdAt: new Date() }],
        supportedModels: ["claude-haiku"],
      });
      (mocks.modelCollection.findOne as any).mockResolvedValue({
        _id: "coder-acp-copilot:claude-haiku",
        capabilities: { reasoningEffort: ["low"] },
      });

      const res = await request(testServer())
        .post(`/api/v1/requests?worker=coder-acp-copilot&projectId=${TEST_PROJECT_ID}`)
        .send({
          scenario: { task: "Build something", criteria: ["works"] },
          model: "claude-haiku",
        });

      expect(res.status).toBe(201);
      expect(res.body.warnings).toBeDefined();
      expect(res.body.warnings.some((w: string) => w.includes("only supports reasoning effort"))).toBe(true);
    });
  });

  // ===================================================================
  // AGENTS.md on request creation
  // ===================================================================

  describe("POST /api/v1/requests?worker=... (AGENTS.md)", () => {
    const setupCopilotAgent = () => {
      (mocks.agentCollection.findOne as any).mockResolvedValue({
        _id: "coder-acp-copilot",
        available: true,
        versions: [{ agentVersion: "v1", status: "active", queueName: "queue-coder-acp-copilot", createdAt: new Date() }],
        supportedModels: ["claude-haiku-4.5"],
      });
    };

    it("resolves agentsMd via findOrCreate(agents.md) and stores agentsMdPromptId", async () => {
      setupCopilotAgent();
      (mocks.taskPromptStore as any).findOrCreate.mockResolvedValue({
        _id: "agents-xyz",
        type: "agents.md",
        text: "# AGENTS\nBe terse.",
        createdAt: new Date(),
      });

      const res = await request(testServer())
        .post(`/api/v1/requests?worker=coder-acp-copilot&projectId=${TEST_PROJECT_ID}`)
        .send({
          scenario: { task: "Build something", criteria: ["works"] },
          model: "claude-haiku-4.5",
          agentsMd: "# AGENTS\nBe terse.",
        });

      expect(res.status).toBe(201);
      const foc = (mocks.taskPromptStore.findOrCreate as any).mock.calls.find(
        (c: any[]) => c[2] === "agents.md"
      );
      expect(foc).toBeDefined();
      expect(foc[0]).toBe(TEST_PROJECT_ID);
      expect(foc[1]).toBe("# AGENTS\nBe terse.");
      const doc = (mocks.collection.insertOne as any).mock.calls[0][0];
      expect(doc).toHaveProperty("agentsMdPromptId", "agents-xyz");
    });

    it("persists agentsMdParentIds lineage on the request", async () => {
      setupCopilotAgent();
      (mocks.taskPromptStore as any).findOrCreate.mockResolvedValue({
        _id: "agents-child",
        type: "agents.md",
        text: "child",
        createdAt: new Date(),
      });

      const res = await request(testServer())
        .post(`/api/v1/requests?worker=coder-acp-copilot&projectId=${TEST_PROJECT_ID}`)
        .send({
          scenario: { task: "Build something", criteria: ["works"] },
          model: "claude-haiku-4.5",
          agentsMd: "child",
          agentsMdParentIds: ["agents-p1", "agents-p2"],
        });

      expect(res.status).toBe(201);
      const doc = (mocks.collection.insertOne as any).mock.calls[0][0];
      expect(doc).toHaveProperty("agentsMdParentIds", ["agents-p1", "agents-p2"]);
    });

    it("omits AGENTS.md fields when not provided", async () => {
      setupCopilotAgent();

      const res = await request(testServer())
        .post(`/api/v1/requests?worker=coder-acp-copilot&projectId=${TEST_PROJECT_ID}`)
        .send({
          scenario: { task: "Build something", criteria: ["works"] },
          model: "claude-haiku-4.5",
        });

      expect(res.status).toBe(201);
      const doc = (mocks.collection.insertOne as any).mock.calls[0][0];
      expect(doc.agentsMdPromptId).toBeUndefined();
      expect(doc.agentsMdParentIds).toBeUndefined();
    });
  });

  // ===================================================================
  // Submit with gates — free-text gate prompt materialization
  // ===================================================================

  describe("POST /api/v1/requests?worker=... (gates)", () => {
    beforeEach(() => {
      (mocks.agentCollection.findOne as any).mockResolvedValue({
        _id: "coder-acp-copilot",
        available: true,
        versions: [{ agentVersion: "v1", status: "active", queueName: "queue-coder-acp-copilot", createdAt: new Date() }],
        supportedModels: ["m1", "m2"],
      });
      // Build gate criterion is compatible with the build gate; "works" is
      // compatible with all gates (no gates restriction).
      (mocks.criteriaCollection.find as any).mockReturnValue({
        toArray: vi.fn().mockResolvedValue([
          { id: "builds_clean", gates: ["build"] },
          { id: "works", gates: [] },
        ]),
      });
      // findOrCreate: select task (1 arg) vs typed gate prompt (text, gate).
      (mocks.taskPromptStore.findOrCreate as any).mockImplementation(
        async (_projectId: string, text: string, type?: string) => ({ _id: type ? `tp-${type}` : "tp-select", text, type }),
      );
      // The resolved gate prompt id resolves to a prompt whose type === gate.
      (mocks.taskPromptCollection.findOne as any).mockImplementation(
        async (q: { _id: string }) => ({ _id: q._id, type: q._id.replace("tp-", "") }),
      );
    });

    it("materializes a free-text gate prompt into a typed prompt and persists the resolved id", async () => {
      const res = await request(testServer())
        .post(`/api/v1/requests?worker=coder-acp-copilot&projectId=${TEST_PROJECT_ID}`)
        .send({
          scenario: { task: "Build something", criteria: ["works"] },
          gates: [
            { gate: "select", criteria: ["works"] },
            { gate: "build", promptText: "  Build the project and fix errors.  ", criteria: ["builds_clean"] },
          ],
        });

      expect(res.status).toBe(201);
      expect(mocks.taskPromptStore.findOrCreate).toHaveBeenCalledWith(TEST_PROJECT_ID, "Build the project and fix errors.", "build");
      const doc = (mocks.collection.insertOne as any).mock.calls[0][0];
      const buildGate = doc.gates.find((g: { gate: string }) => g.gate === "build");
      expect(buildGate.promptId).toBe("tp-build");
      expect(buildGate.promptText).toBeUndefined();
    });

    it("lets promptText supersede a provided promptId", async () => {
      const res = await request(testServer())
        .post(`/api/v1/requests?worker=coder-acp-copilot&projectId=${TEST_PROJECT_ID}`)
        .send({
          scenario: { task: "Build something", criteria: ["works"] },
          gates: [
            { gate: "select", criteria: ["works"] },
            { gate: "build", promptId: "stale-id", promptText: "Fresh build prompt.", criteria: ["builds_clean"] },
          ],
        });

      expect(res.status).toBe(201);
      expect(mocks.taskPromptStore.findOrCreate).toHaveBeenCalledWith(TEST_PROJECT_ID, "Fresh build prompt.", "build");
      const doc = (mocks.collection.insertOne as any).mock.calls[0][0];
      const buildGate = doc.gates.find((g: { gate: string }) => g.gate === "build");
      expect(buildGate.promptId).toBe("tp-build");
    });

    it("returns 400 when a non-select gate has neither promptId nor promptText", async () => {
      const res = await request(testServer())
        .post(`/api/v1/requests?worker=coder-acp-copilot&projectId=${TEST_PROJECT_ID}`)
        .send({
          scenario: { task: "Build something", criteria: ["works"] },
          gates: [
            { gate: "select", criteria: ["works"] },
            { gate: "build", criteria: ["builds_clean"] },
          ],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("missing a prompt");
    });
  });

  // ===================================================================
  // Submit with profile variations AND gates (regression: #1214)
  // Gates are the shared evaluation harness applied to every variation
  // (including the base), not a per-variation controlled field.
  // ===================================================================

  describe("POST /api/v1/requests (profile variations + gates)", () => {
    beforeEach(() => {
      // Base + variation profiles resolved by _id.
      (mocks.profileCollection.findOne as any).mockImplementation(
        async (q: { _id: string }) => {
          if (q._id === "base-profile") return { _id: "base-profile", name: "Base", latestVersion: 1 };
          if (q._id === "var-profile") return { _id: "var-profile", name: "Var", latestVersion: 1 };
          return null;
        },
      );
      // Profile versions resolved by profileId — each variation supplies its own
      // controlled config (worker/model) so no top-level fields are needed.
      (mocks.profileVersionCollection.findOne as any).mockImplementation(
        async (q: { profileId: string }) => {
          if (q.profileId === "base-profile")
            return { _id: "pv-base", profileId: "base-profile", version: 1, workerType: "coder-acp-copilot", model: "m1", mcpServers: [], skillRevisions: [], extensions: [] };
          if (q.profileId === "var-profile")
            return { _id: "pv-var", profileId: "var-profile", version: 1, workerType: "coder-acp-copilot", model: "m2", mcpServers: [], skillRevisions: [], extensions: [] };
          return null;
        },
      );
      (mocks.agentCollection.findOne as any).mockResolvedValue({
        _id: "coder-acp-copilot",
        available: true,
        versions: [{ agentVersion: "v1", status: "active", queueName: "queue-coder-acp-copilot", createdAt: new Date() }],
        supportedModels: ["m1", "m2"],
      });
      (mocks.criteriaCollection.find as any).mockReturnValue({
        toArray: vi.fn().mockResolvedValue([
          { id: "builds_clean", gates: ["build"] },
          { id: "works", gates: [] },
        ]),
      });
      (mocks.taskPromptStore.findOrCreate as any).mockImplementation(
        async (_projectId: string, text: string, type?: string) => ({ _id: type ? `tp-${type}` : "tp-select", text, type }),
      );
      (mocks.taskPromptCollection.findOne as any).mockImplementation(
        async (q: { _id: string }) => ({ _id: q._id, type: q._id.replace("tp-", "") }),
      );
    });

    it("persists the same resolved gates on every variation request doc", async () => {
      const res = await request(testServer())
        .post(`/api/v1/requests?projectId=${TEST_PROJECT_ID}`)
        .send({
          scenario: { task: "Build something", criteria: ["works"] },
          profileId: "base-profile",
          profileVariations: ["var-profile"],
          gates: [
            { gate: "select", criteria: ["works"] },
            { gate: "build", promptText: "  Build the project and fix errors.  ", criteria: ["builds_clean"] },
          ],
        });

      expect(res.status).toBe(201);
      // Free-text gate prompt is materialized into a typed prompt.
      expect(mocks.taskPromptStore.findOrCreate).toHaveBeenCalledWith(TEST_PROJECT_ID, "Build the project and fix errors.", "build");

      const docs = (mocks.collection.insertMany as any).mock.calls[0][0];
      // base + 1 variation = 2 request docs, each carrying the gates.
      expect(docs).toHaveLength(2);
      expect(new Set(docs.map((d: { profileId: string }) => d.profileId))).toEqual(
        new Set(["base-profile", "var-profile"]),
      );
      for (const doc of docs) {
        expect(Array.isArray(doc.gates)).toBe(true);
        const selectGate = doc.gates.find((g: { gate: string }) => g.gate === "select");
        const buildGate = doc.gates.find((g: { gate: string }) => g.gate === "build");
        // Select gate's prompt is stamped with the resolved task prompt id.
        expect(selectGate.promptId).toBe("tp-select");
        // Non-select gate's free-text prompt is resolved to a typed prompt id
        // and the transient promptText is stripped before persistence.
        expect(buildGate.promptId).toBe("tp-build");
        expect(buildGate.promptText).toBeUndefined();
      }
      // Response surfaces the configured gate count.
      expect(res.body.gates).toBe(2);
    });

    it("fails the whole submit (400) without inserting when a gate is invalid", async () => {
      const res = await request(testServer())
        .post(`/api/v1/requests?projectId=${TEST_PROJECT_ID}`)
        .send({
          scenario: { task: "Build something", criteria: ["works"] },
          profileId: "base-profile",
          profileVariations: ["var-profile"],
          gates: [
            { gate: "select", criteria: ["works"] },
            // Build gate has neither promptId nor promptText → invalid.
            { gate: "build", criteria: ["builds_clean"] },
          ],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("missing a prompt");
      expect(mocks.collection.insertMany).not.toHaveBeenCalled();
    });
  });

  // ===================================================================
  // Bulk resubmit
  // ===================================================================

  describe("POST /api/v1/requests/bulk-resubmit (reasoning effort)", () => {
    it("applies reasoning effort override in bulk resubmit", async () => {
      const originalRun = {
        _id: "run-original",
        scenario: { task: "Build a form", criteria: ["has_react"] },
        workerType: "coder-acp-copilot",
        status: "completed",
        model: "gpt-4o",
        reasoningEffort: "low",
        createdAt: new Date(),
        maxIterations: 5,
      };

      const mockCursor = {
        toArray: vi.fn().mockResolvedValue([originalRun]),
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
      };
      (mocks.collection.find as any).mockReturnValue(mockCursor);

      (mocks.agentCollection.findOne as any).mockResolvedValue({
        _id: "coder-acp-copilot",
        available: true,
        versions: [
          { agentVersion: "copilot-0.0.420", queueName: "queue-coder-acp-copilot", status: "active", createdAt: new Date() },
        ],
        supportedModels: ["gpt-4o", "claude-sonnet-4"],
      });

      const res = await request(testServer())
        .post("/api/v1/requests/bulk-resubmit")
        .send({ ids: ["run-original"], count: 1, overrides: { reasoningEffort: "high" } });

      expect(res.status).toBe(201);
      const insertCall = (mocks.collection.insertMany as any).mock.calls[0][0];
      expect(insertCall[0]).toHaveProperty("reasoningEffort", "high");
    });

    it("clears reasoning effort when override is null", async () => {
      const originalRun = {
        _id: "run-original",
        scenario: { task: "Build a form", criteria: ["has_react"] },
        workerType: "coder-acp-copilot",
        status: "completed",
        model: "gpt-4o",
        reasoningEffort: "high",
        createdAt: new Date(),
        maxIterations: 5,
      };

      const mockCursor = {
        toArray: vi.fn().mockResolvedValue([originalRun]),
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
      };
      (mocks.collection.find as any).mockReturnValue(mockCursor);

      (mocks.agentCollection.findOne as any).mockResolvedValue({
        _id: "coder-acp-copilot",
        available: true,
        versions: [
          { agentVersion: "copilot-0.0.420", queueName: "queue-coder-acp-copilot", status: "active", createdAt: new Date() },
        ],
        supportedModels: ["gpt-4o"],
      });

      const res = await request(testServer())
        .post("/api/v1/requests/bulk-resubmit")
        .send({ ids: ["run-original"], count: 1, overrides: { reasoningEffort: null } });

      expect(res.status).toBe(201);
      const insertCall = (mocks.collection.insertMany as any).mock.calls[0][0];
      expect(insertCall[0].reasoningEffort).toBeUndefined();
    });
  });

  // ===================================================================
  // Bulk resubmit (original tests)
  // ===================================================================

  describe("POST /api/v1/requests/bulk-resubmit", () => {
    it("preserves agentVersion and taskPromptId from original run", async () => {
      const originalRun = {
        _id: "run-original",
        scenario: { task: "Build a form", criteria: ["has_react"] },
        workerType: "coder-acp-copilot",
        status: "completed",
        model: "gpt-4o",
        agentVersion: "copilot-0.0.415",
        taskPromptId: "tp-123",
        personaInstructions: "Be helpful",
        createdAt: new Date(),
        maxIterations: 5,
      };

      // Mock collection.find to return the original run
      const mockCursor = {
        toArray: vi.fn().mockResolvedValue([originalRun]),
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
      };
      (mocks.collection.find as any).mockReturnValue(mockCursor);

      // Mock agentCollection.findOne to return an agent with an active version
      (mocks.agentCollection.findOne as any).mockResolvedValue({
        _id: "coder-acp-copilot",
        available: true,
        versions: [
          { agentVersion: "copilot-0.0.420", queueName: "queue-coder-acp-copilot", status: "active", createdAt: new Date() },
        ],
        supportedModels: ["gpt-4o"],
      });

      const res = await request(testServer())
        .post("/api/v1/requests/bulk-resubmit")
        .send({ ids: ["run-original"], count: 1 });

      expect(res.status).toBe(201);

      // Verify the inserted document includes agentVersion and taskPromptId
      const insertCall = (mocks.collection.insertMany as any).mock.calls[0][0];
      expect(insertCall).toHaveLength(1);
      expect(insertCall[0]).toHaveProperty("agentVersion", "copilot-0.0.420");
      expect(insertCall[0]).toHaveProperty("taskPromptId", "tp-123");
      expect(insertCall[0]).toHaveProperty("model", "gpt-4o");
      expect(insertCall[0]).toHaveProperty("maxIterations", 5);
    });

    it("applies profile override: uses profile fields for worker, model, mcpServers, skillRevisions, extensions", async () => {
      const originalRun = {
        _id: "run-original",
        scenario: { task: "Build a form", criteria: ["has_react"] },
        workerType: "coder-acp-copilot",
        status: "completed",
        model: "gpt-4o",
        createdAt: new Date(),
        maxIterations: 5,
      };

      const mockCursor = {
        toArray: vi.fn().mockResolvedValue([originalRun]),
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
      };
      (mocks.collection.find as any).mockReturnValue(mockCursor);

      // Profile + version mocks
      (mocks.profileCollection.findOne as any).mockResolvedValue({
        _id: "profile-1",
        name: "My Profile",
        latestVersion: 2,
      });
      (mocks.profileVersionCollection.findOne as any).mockResolvedValue({
        _id: "pv-2",
        profileId: "profile-1",
        version: 2,
        workerType: "coder-vscode-insiders",
        model: "claude-sonnet-4",
        mcpServers: ["mcp-a"],
        skillRevisions: ["skill-a@v1"],
        extensions: ["ext-a"],
      });

      (mocks.agentCollection.findOne as any).mockResolvedValue({
        _id: "coder-vscode-insiders",
        available: true,
        versions: [
          { agentVersion: "insiders-0.1.0", queueName: "queue-vscode-insiders", status: "active", createdAt: new Date() },
        ],
        supportedModels: ["claude-sonnet-4"],
      });

      // Skill resolution mocks (resolveSkillSpecs validates slug + pinned ref)
      (mocks.skillCollection.find as any).mockReturnValue({
        toArray: vi.fn().mockResolvedValue([{ _id: "skill-a" }]),
      });
      (mocks.skillRevisionStore.getByRef as any).mockResolvedValue({
        _id: "rev-skill-a",
        ref: "skill-a@v1",
      });

      const res = await request(testServer())
        .post("/api/v1/requests/bulk-resubmit")
        .send({
          ids: ["run-original"],
          count: 1,
          overrides: {
            profileId: "profile-1",
            maxIterations: 10, // not controlled by profile — allowed
          },
        });

      expect(res.status).toBe(201);

      const insertCall = (mocks.collection.insertMany as any).mock.calls[0][0];
      expect(insertCall).toHaveLength(1);
      const doc = insertCall[0];
      // Profile-controlled fields come from profile version
      expect(doc).toHaveProperty("workerType", "coder-vscode-insiders");
      expect(doc).toHaveProperty("model", "claude-sonnet-4");
      expect(doc).toHaveProperty("mcpServers", ["mcp-a"]);
      expect(doc).toHaveProperty("skillRevisions", ["skill-a@v1"]);
      expect(doc).toHaveProperty("extensions", ["ext-a"]);
      expect(doc).toHaveProperty("profileId", "profile-1");
      expect(doc).toHaveProperty("profileVersionId", "pv-2");
      // maxIterations is not profile-controlled
      expect(doc).toHaveProperty("maxIterations", 10);
    });

    it("detaches profile when profileId override is null", async () => {
      const originalRun = {
        _id: "run-original",
        scenario: { task: "Build a form", criteria: ["has_react"] },
        workerType: "coder-acp-copilot",
        status: "completed",
        model: "gpt-4o",
        profileId: "old-profile",
        profileVersionId: "old-pv",
        createdAt: new Date(),
        maxIterations: 5,
      };

      const mockCursor = {
        toArray: vi.fn().mockResolvedValue([originalRun]),
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
      };
      (mocks.collection.find as any).mockReturnValue(mockCursor);

      (mocks.agentCollection.findOne as any).mockResolvedValue({
        _id: "coder-acp-copilot",
        available: true,
        versions: [
          { agentVersion: "copilot-0.0.420", queueName: "queue-coder-acp-copilot", status: "active", createdAt: new Date() },
        ],
        supportedModels: ["gpt-4o", "claude-sonnet-4"],
      });

      const res = await request(testServer())
        .post("/api/v1/requests/bulk-resubmit")
        .send({
          ids: ["run-original"],
          count: 1,
          overrides: { profileId: null, model: "claude-sonnet-4" },
        });

      expect(res.status).toBe(201);

      const insertCall = (mocks.collection.insertMany as any).mock.calls[0][0];
      const doc = insertCall[0];
      // Profile detached — no profile fields
      expect(doc.profileId).toBeUndefined();
      expect(doc.profileVersionId).toBeUndefined();
      // Individual overrides respected since no profile active
      expect(doc).toHaveProperty("model", "claude-sonnet-4");
    });

    it("returns 404 when profile override references non-existent profile", async () => {
      (mocks.profileCollection.findOne as any).mockResolvedValue(null);

      const res = await request(testServer())
        .post("/api/v1/requests/bulk-resubmit")
        .send({
          ids: ["run-1"],
          count: 1,
          overrides: { profileId: "nonexistent" },
        });

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Profile not found");
    });

    it("returns 400 when individual overrides conflict with profile", async () => {
      (mocks.profileCollection.findOne as any).mockResolvedValue({
        _id: "profile-1",
        name: "My Profile",
        latestVersion: 1,
      });
      (mocks.profileVersionCollection.findOne as any).mockResolvedValue({
        _id: "pv-1",
        profileId: "profile-1",
        version: 1,
        workerType: "coder-acp-copilot",
        model: "claude-sonnet-4",
        mcpServers: [],
        skillRevisions: [],
        extensions: [],
      });

      const res = await request(testServer())
        .post("/api/v1/requests/bulk-resubmit")
        .send({
          ids: ["run-1"],
          count: 1,
          overrides: {
            profileId: "profile-1",
            model: "gpt-4o", // conflicts with profile
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("controls these fields");
      expect(res.body.conflicts).toEqual(
        expect.arrayContaining([expect.stringContaining("model")])
      );
    });
  });

  // ===================================================================
  // Run-retry-attempts (issue #658)
  // ===================================================================

  describe("GET /api/v1/requests/:id/runs", () => {
    it("returns 404 when request not found", async () => {
      (mocks.collection.findOne as any).mockResolvedValue(null);
      const res = await request(testServer()).get("/api/v1/requests/missing/runs");
      expect(res.status).toBe(404);
    });

    it("returns current run + history newest first", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "req-1",
        run: { _id: "run-2", attemptNumber: 2, status: "pending" },
      });
      (mocks.runsCollection.find as any).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([
            { _id: "run-1", attemptNumber: 1, status: "done", outcome: "failed", requestId: "req-1" },
          ]),
        }),
      });
      const res = await request(testServer()).get("/api/v1/requests/req-1/runs");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0]._id).toBe("run-2");
      expect(res.body[1]._id).toBe("run-1");
    });
  });

  describe("GET /api/v1/requests/:id/runs/:runId", () => {
    it("returns the inline current run when runId matches", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "req-1",
        run: { _id: "run-2", attemptNumber: 2, status: "pending" },
      });
      const res = await request(testServer()).get("/api/v1/requests/req-1/runs/run-2");
      expect(res.status).toBe(200);
      expect(res.body._id).toBe("run-2");
    });

    it("falls back to history collection for older attempts", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "req-1",
        run: { _id: "run-2", attemptNumber: 2, status: "pending" },
      });
      (mocks.runsCollection.findOne as any).mockResolvedValue({
        _id: "run-1",
        attemptNumber: 1,
        status: "done",
        outcome: "failed",
        requestId: "req-1",
      });
      const res = await request(testServer()).get("/api/v1/requests/req-1/runs/run-1");
      expect(res.status).toBe(200);
      expect(res.body._id).toBe("run-1");
    });

    it("returns 404 when run id doesn't belong to the request", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "req-1",
        run: { _id: "run-2", attemptNumber: 2, status: "pending" },
      });
      (mocks.runsCollection.findOne as any).mockResolvedValue({
        _id: "run-x",
        requestId: "other-req",
        attemptNumber: 1,
        status: "done",
      });
      const res = await request(testServer()).get("/api/v1/requests/req-1/runs/run-x");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/v1/requests/:id/retry", () => {
    it("returns 404 when request not found", async () => {
      (mocks.collection.findOne as any).mockResolvedValue(null);
      const res = await request(testServer()).post("/api/v1/requests/missing/retry");
      expect(res.status).toBe(404);
    });

    it("returns 422 when current run is not yet terminal", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "req-1",
        workerType: "coder-acp-copilot",
        run: { _id: "run-1", attemptNumber: 1, status: "processing" },
      });
      const res = await request(testServer()).post("/api/v1/requests/req-1/retry");
      expect(res.status).toBe(422);
      expect(res.body.error).toContain("expected 'done'");
    });

    it("demotes current run to history, swaps in a new attempt", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "req-1",
        workerType: "coder-acp-copilot",
        run: { _id: "run-1", attemptNumber: 1, status: "done", outcome: "failed" },
      });
      (mocks.runsCollection.insertOne as any).mockResolvedValue({ insertedId: "run-1" });
      (mocks.collection.updateOne as any).mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });

      const res = await request(testServer()).post("/api/v1/requests/req-1/retry");

      expect(res.status).toBe(201);
      expect(res.body.attemptNumber).toBe(2);
      expect(res.body.requestId).toBe("req-1");
      expect(typeof res.body.runId).toBe("string");
      expect(mocks.runsCollection.insertOne).toHaveBeenCalledWith(
        expect.objectContaining({ _id: "run-1", requestId: "req-1" }),
      );
      expect(mocks.collection.updateOne).toHaveBeenCalledWith(
        { _id: "req-1", "run._id": "run-1" },
        expect.objectContaining({
          $set: expect.objectContaining({
            agentVersion: "1.0.0",
            run: expect.objectContaining({ attemptNumber: 2, status: "pending" }),
          }),
        }),
      );
    });

    it("returns 409 when retrying a successful run without force=true", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "req-1",
        workerType: "coder-acp-copilot",
        run: { _id: "run-1", attemptNumber: 1, status: "done", outcome: "succeeded" },
      });

      const res = await request(testServer()).post("/api/v1/requests/req-1/retry");
      expect(res.status).toBe(409);
      expect(res.body.error).toContain("force=true");
    });

    it("retries a successful run when force=true", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "req-1",
        workerType: "coder-acp-copilot",
        run: { _id: "run-1", attemptNumber: 1, status: "done", outcome: "succeeded" },
      });
      (mocks.runsCollection.insertOne as any).mockResolvedValue({ insertedId: "run-1" });
      (mocks.collection.updateOne as any).mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });

      const res = await request(testServer()).post("/api/v1/requests/req-1/retry").send({ force: true });
      expect(res.status).toBe(201);
      expect(res.body.attemptNumber).toBe(2);
    });

    it("returns 409 when concurrent retry wins the race", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "req-1",
        workerType: "coder-acp-copilot",
        run: { _id: "run-1", attemptNumber: 1, status: "done", outcome: "failed" },
      });
      (mocks.runsCollection.insertOne as any).mockResolvedValue({ insertedId: "run-1" });
      (mocks.collection.updateOne as any).mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });

      const res = await request(testServer()).post("/api/v1/requests/req-1/retry");
      expect(res.status).toBe(409);
    });

    it("returns 409 when request is soft-deleted", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "req-1",
        workerType: "coder-acp-copilot",
        deletedAt: new Date(),
        run: { _id: "run-1", attemptNumber: 1, status: "done" },
      });
      const res = await request(testServer()).post("/api/v1/requests/req-1/retry");
      expect(res.status).toBe(409);
    });

    it("ignores duplicate-key error on history insertion", async () => {
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "req-1",
        workerType: "coder-acp-copilot",
        run: { _id: "run-1", attemptNumber: 1, status: "done", outcome: "failed" },
      });
      const dupErr: any = new Error("E11000 duplicate key");
      dupErr.code = 11000;
      (mocks.runsCollection.insertOne as any).mockRejectedValue(dupErr);
      (mocks.collection.updateOne as any).mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });

      const res = await request(testServer()).post("/api/v1/requests/req-1/retry");
      expect(res.status).toBe(201);
    });
  });

  describe("POST /api/v1/requests/bulk-retry", () => {
    it("retries eligible requests and skips non-terminal ones", async () => {
      const doc1 = {
        _id: "req-1",
        workerType: "coder-acp-copilot",
        run: { _id: "run-1", attemptNumber: 1, status: "done", outcome: "failed" },
      };
      const doc2 = {
        _id: "req-2",
        workerType: "coder-acp-copilot",
        run: { _id: "run-2", attemptNumber: 1, status: "processing" },
      };
      // find().toArray() is used by bulk-retry to fetch all docs at once
      const mockCursor = { toArray: vi.fn().mockResolvedValue([doc1, doc2]), sort: vi.fn().mockReturnThis(), skip: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), filter: vi.fn().mockReturnThis(), project: vi.fn().mockReturnThis() };
      (mocks.collection.find as any).mockReturnValue(mockCursor);
      (mocks.runsCollection.insertOne as any).mockResolvedValue({ insertedId: "run-1" });
      (mocks.collection.updateOne as any).mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });

      const res = await request(testServer())
        .post("/api/v1/requests/bulk-retry")
        .send({ ids: ["req-1", "req-2"] });

      expect(res.status).toBe(201);
      expect(res.body.retried).toBe(1);
      expect(res.body.skipped).toBe(1);
      expect(res.body.results).toHaveLength(2);
      expect(res.body.results.find((r: any) => r.requestId === "req-1").attemptNumber).toBe(2);
      expect(res.body.results.find((r: any) => r.requestId === "req-2").error).toContain("processing");
      expect(mocks.collection.updateOne).toHaveBeenCalledWith(
        { _id: "req-1", "run._id": "run-1" },
        expect.objectContaining({
          $set: expect.objectContaining({ agentVersion: "1.0.0" }),
        }),
      );
    });

    it("returns 400 when ids array is empty", async () => {
      const res = await request(testServer())
        .post("/api/v1/requests/bulk-retry")
        .send({ ids: [] });
      expect(res.status).toBe(400);
    });
  });

  // ===================================================================
  // Priority endpoints
  // ===================================================================

  describe("POST /api/v1/requests/:id/priority", () => {
    it("sets priority on a single request", async () => {
      (mocks.collection.updateOne as any).mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });

      const res = await request(testServer())
        .post("/api/v1/requests/r1/priority")
        .send({ priority: 5 });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: "r1", priority: 5 });
    });

    it("returns 404 when request not found", async () => {
      (mocks.collection.updateOne as any).mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });

      const res = await request(testServer())
        .post("/api/v1/requests/missing/priority")
        .send({ priority: 3 });
      expect(res.status).toBe(404);
    });

    it("returns 400 when priority is not an integer", async () => {
      const res = await request(testServer())
        .post("/api/v1/requests/r1/priority")
        .send({ priority: 1.5 });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/v1/requests/bulk-priority", () => {
    it("sets priority on multiple requests", async () => {
      (mocks.collection.updateMany as any).mockResolvedValue({ matchedCount: 2, modifiedCount: 2 });

      const res = await request(testServer())
        .post("/api/v1/requests/bulk-priority")
        .send({ ids: ["r1", "r2"], priority: 10 });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ updated: 2, skipped: 0 });
    });

    it("returns skipped count for non-existent ids", async () => {
      (mocks.collection.updateMany as any).mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });

      const res = await request(testServer())
        .post("/api/v1/requests/bulk-priority")
        .send({ ids: ["r1", "missing"], priority: 5 });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ updated: 1, skipped: 1 });
    });
  });

  // ===================================================================
  // Pause / Resume endpoints
  // ===================================================================

  describe("POST /api/v1/requests/:id/pause", () => {
    it("pauses a pending request", async () => {
      (mocks.collection.updateOne as any).mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });

      const res = await request(testServer()).post("/api/v1/requests/r1/pause");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: "r1", status: "paused" });
    });

    it("returns 404 when request not found", async () => {
      (mocks.collection.updateOne as any).mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
      (mocks.collection.findOne as any).mockResolvedValue(null);

      const res = await request(testServer()).post("/api/v1/requests/missing/pause");
      expect(res.status).toBe(404);
    });

    it("returns 409 when request is processing", async () => {
      (mocks.collection.updateOne as any).mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "r1",
        run: { _id: "run1", status: "processing" },
      });

      const res = await request(testServer()).post("/api/v1/requests/r1/pause");
      expect(res.status).toBe(409);
      expect(res.body.error).toContain("processing");
    });
  });

  describe("POST /api/v1/requests/:id/resume", () => {
    it("resumes a paused request", async () => {
      (mocks.collection.updateOne as any).mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });

      const res = await request(testServer()).post("/api/v1/requests/r1/resume");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: "r1", status: "pending" });
    });

    it("returns 404 when request not found", async () => {
      (mocks.collection.updateOne as any).mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
      (mocks.collection.findOne as any).mockResolvedValue(null);

      const res = await request(testServer()).post("/api/v1/requests/missing/resume");
      expect(res.status).toBe(404);
    });

    it("returns 409 when request is not paused", async () => {
      (mocks.collection.updateOne as any).mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
      (mocks.collection.findOne as any).mockResolvedValue({
        _id: "r1",
        run: { _id: "run1", status: "pending" },
      });

      const res = await request(testServer()).post("/api/v1/requests/r1/resume");
      expect(res.status).toBe(409);
      expect(res.body.error).toContain("pending");
    });
  });

  describe("POST /api/v1/requests/bulk-pause", () => {
    it("pauses multiple requests", async () => {
      (mocks.collection.updateMany as any).mockResolvedValue({ matchedCount: 2, modifiedCount: 2 });

      const res = await request(testServer())
        .post("/api/v1/requests/bulk-pause")
        .send({ ids: ["r1", "r2"] });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ updated: 2, skipped: 0 });
    });

    it("returns skipped count for non-pausable requests", async () => {
      (mocks.collection.updateMany as any).mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });

      const res = await request(testServer())
        .post("/api/v1/requests/bulk-pause")
        .send({ ids: ["r1", "r2", "r3"] });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ updated: 1, skipped: 2 });
    });
  });

  describe("POST /api/v1/requests/bulk-resume", () => {
    it("resumes multiple paused requests", async () => {
      (mocks.collection.updateMany as any).mockResolvedValue({ matchedCount: 2, modifiedCount: 2 });

      const res = await request(testServer())
        .post("/api/v1/requests/bulk-resume")
        .send({ ids: ["r1", "r2"] });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ updated: 2, skipped: 0 });
    });
  });
});
