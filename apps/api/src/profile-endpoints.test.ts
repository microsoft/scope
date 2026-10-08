// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { app, _injectTestDependencies } from "./index.js";
import { useTestServer } from "./test-server.js";
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

describe("Profile API Endpoints", () => {
  const testServer = useTestServer(app);
  let mocks: ReturnType<typeof createAllMockDependencies>;

  beforeAll(() => {
    mocks = createAllMockDependencies();
    _injectTestDependencies(mocks);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = createAllMockDependencies();
    _injectTestDependencies(mocks);
    // Default: assume the target agent exists and exposes the model used in
    // tests below. Individual tests can override this to assert the new
    // capability-check failure paths.
    (mocks.agentCollection.findOne as any).mockResolvedValue({
      _id: "coder-acp-copilot",
      name: "Copilot",
      available: true,
      supportedModels: ["gpt-4o", "gpt-5"],
      capabilities: { supportsExtensions: false },
      versions: [
        {
          agentVersion: "v1",
          status: "active",
          queueName: "queue-coder-acp-copilot",
          createdAt: new Date(),
        },
      ],
    });
  });

  describe("POST /api/v1/profiles", () => {
    it("creates a profile and initial version", async () => {
      const profileCol = mocks.profileCollection as any;
      const versionCol = mocks.profileVersionCollection as any;
      profileCol.insertOne = vi.fn().mockResolvedValue({ insertedId: "p-new" });
      versionCol.insertOne = vi.fn().mockResolvedValue({ insertedId: "pv-new" });

      const res = await request(testServer())
        .post(`/api/v1/profiles?projectId=${TEST_PROJECT_ID}`)
        .send({
          name: "Test Profile",
          workerType: "coder-acp-copilot",
          model: "gpt-4o",
        });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("_id");
      expect(res.body).toHaveProperty("name", "Test Profile");
      expect(res.body).toHaveProperty("latestVersion", 1);
      expect(profileCol.insertOne).toHaveBeenCalledOnce();
      expect(versionCol.insertOne).toHaveBeenCalledOnce();
    });

    it("resolves skill slugs to revision refs", async () => {
      const profileCol = mocks.profileCollection as any;
      const versionCol = mocks.profileVersionCollection as any;
      const skillCol = mocks.skillCollection as any;

      profileCol.insertOne = vi.fn().mockResolvedValue({ insertedId: "p-new" });
      versionCol.insertOne = vi.fn().mockResolvedValue({ insertedId: "pv-new" });
      skillCol.find = vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue([
          { _id: "github/org/my-skill", source: "github/org", skillName: "my-skill" },
        ]),
      });
      mocks.skillResolver.resolve = vi.fn().mockResolvedValue({
        ref: "github/org/my-skill@abc1234",
      });

      const res = await request(testServer())
        .post(`/api/v1/profiles?projectId=${TEST_PROJECT_ID}`)
        .send({
          name: "With Skills",
          workerType: "coder-acp-copilot",
          model: "gpt-4o",
          skillRevisions: ["github/org/my-skill"],
        });

      expect(res.status).toBe(201);
      expect(res.body.version.skillRevisions).toEqual(["github/org/my-skill@abc1234"]);
      expect(mocks.skillResolver.resolve).toHaveBeenCalledOnce();
    });

    it("accepts pre-pinned skill specs (slug@hash)", async () => {
      const profileCol = mocks.profileCollection as any;
      const versionCol = mocks.profileVersionCollection as any;
      const skillCol = mocks.skillCollection as any;

      profileCol.insertOne = vi.fn().mockResolvedValue({ insertedId: "p-new" });
      versionCol.insertOne = vi.fn().mockResolvedValue({ insertedId: "pv-new" });
      skillCol.find = vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue([
          { _id: "github/org/my-skill", source: "github/org", skillName: "my-skill" },
        ]),
      });
      mocks.skillRevisionStore.getByRef = vi.fn().mockResolvedValue({
        ref: "github/org/my-skill@abc1234",
        commitHash: "abc1234",
      });

      const res = await request(testServer())
        .post(`/api/v1/profiles?projectId=${TEST_PROJECT_ID}`)
        .send({
          name: "Pinned Skills",
          workerType: "coder-acp-copilot",
          model: "gpt-4o",
          skillRevisions: ["github/org/my-skill@abc1234"],
        });

      expect(res.status).toBe(201);
      expect(res.body.version.skillRevisions).toEqual(["github/org/my-skill@abc1234"]);
      expect(mocks.skillRevisionStore.getByRef).toHaveBeenCalledWith(TEST_PROJECT_ID, "github/org/my-skill@abc1234");
      expect(mocks.skillResolver.resolve).not.toHaveBeenCalled();
    });

    it("rejects missing name", async () => {
      const res = await request(testServer())
        .post(`/api/v1/profiles?projectId=${TEST_PROJECT_ID}`)
        .send({
          workerType: "coder-acp-copilot",
          model: "gpt-4o",
        });

      expect(res.status).toBe(400);
    });

    it("rejects missing model", async () => {
      const res = await request(testServer())
        .post(`/api/v1/profiles?projectId=${TEST_PROJECT_ID}`)
        .send({
          name: "No Model",
          workerType: "coder-acp-copilot",
        });

      expect(res.status).toBe(400);
    });

    it("allows capability mismatches while strict enforcement is disabled", async () => {
      const res = await request(testServer())
        .post(`/api/v1/profiles?projectId=${TEST_PROJECT_ID}`)
        .send({
          name: "Bad Combo",
          workerType: "coder-acp-copilot",
          model: "gpt-4o",
          extensions: ["ms-azuretools.vscode-cosmosdb@0.32.1"],
        });

      expect(res.status).toBe(201);
      expect(res.body.version.agentVersion).toBe("v1");
    });
  });

  describe("POST /api/v1/profiles/:profileId (new version)", () => {
    it("allows capability mismatches while strict enforcement is disabled", async () => {
      const profileCol = mocks.profileCollection as any;
      profileCol.findOne = vi.fn().mockResolvedValue({
        _id: "p-1",
        name: "ACP Profile",
        latestVersion: 1,
        createdAt: new Date(),
      });

      const res = await request(testServer())
        .post("/api/v1/profiles/p-1")
        .send({
          workerType: "coder-acp-copilot",
          model: "gpt-4o",
          extensions: ["ms-azuretools.vscode-cosmosdb@0.32.1"],
        });

      expect(res.status).toBe(201);
      expect(res.body.agentVersion).toBe("v1");
    });
  });

  describe("GET /api/v1/profiles", () => {
    it("returns list of non-deleted profiles with latest version", async () => {
      const profileCol = mocks.profileCollection as any;
      const versionCol = mocks.profileVersionCollection as any;

      const profiles = [
        { _id: "p-1", name: "Profile 1", latestVersion: 2, createdAt: new Date() },
      ];
      profileCol.find = vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue(profiles),
        }),
      });
      versionCol.findOne = vi.fn().mockResolvedValue({
        _id: "pv-1",
        profileId: "p-1",
        version: 2,
        workerType: "coder-acp-copilot",
        model: "gpt-4o",
        createdAt: new Date(),
      });

      const res = await request(testServer()).get(`/api/v1/profiles?projectId=${TEST_PROJECT_ID}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toHaveProperty("name", "Profile 1");
      expect(res.body[0]).toHaveProperty("version");
    });
  });

  describe("GET /api/v1/profiles/:id", () => {
    it("returns 404 for non-existent profile", async () => {
      const profileCol = mocks.profileCollection as any;
      profileCol.findOne = vi.fn().mockResolvedValue(null);

      const res = await request(testServer()).get("/api/v1/profiles/nonexistent");

      expect(res.status).toBe(404);
    });

    it("returns profile with latest version", async () => {
      const profileCol = mocks.profileCollection as any;
      const versionCol = mocks.profileVersionCollection as any;

      profileCol.findOne = vi.fn().mockResolvedValue({
        _id: "p-1",
        name: "My Profile",
        latestVersion: 1,
        createdAt: new Date(),
      });
      versionCol.findOne = vi.fn().mockResolvedValue({
        _id: "pv-1",
        profileId: "p-1",
        version: 1,
        workerType: "coder-acp-copilot",
        model: "gpt-4o",
        createdAt: new Date(),
      });

      const res = await request(testServer()).get("/api/v1/profiles/p-1");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("name", "My Profile");
      expect(res.body).toHaveProperty("version");
      expect(res.body.version).toHaveProperty("model", "gpt-4o");
    });
  });

  describe("DELETE /api/v1/profiles/:id", () => {
    it("soft-deletes a profile", async () => {
      const profileCol = mocks.profileCollection as any;
      profileCol.findOne = vi.fn().mockResolvedValue({
        _id: "p-1",
        name: "To Delete",
        latestVersion: 1,
        createdAt: new Date(),
      });
      profileCol.updateOne = vi.fn().mockResolvedValue({ matchedCount: 1 });

      const res = await request(testServer()).delete("/api/v1/profiles/p-1");

      expect(res.status).toBe(204);
      expect(profileCol.updateOne).toHaveBeenCalledOnce();
    });

    it("returns 404 for non-existent profile", async () => {
      const profileCol = mocks.profileCollection as any;
      profileCol.findOne = vi.fn().mockResolvedValue(null);

      const res = await request(testServer()).delete("/api/v1/profiles/nonexistent");

      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/v1/profiles/:id/versions", () => {
    it("returns all versions sorted desc", async () => {
      const profileCol = mocks.profileCollection as any;
      const versionCol = mocks.profileVersionCollection as any;

      profileCol.findOne = vi.fn().mockResolvedValue({
        _id: "p-1",
        name: "Profile 1",
        latestVersion: 2,
        createdAt: new Date(),
      });
      const versions = [
        { _id: "pv-2", profileId: "p-1", version: 2, workerType: "coder-acp-copilot", model: "gpt-4o", createdAt: new Date() },
        { _id: "pv-1", profileId: "p-1", version: 1, workerType: "coder-acp-copilot", model: "gpt-4", createdAt: new Date() },
      ];
      versionCol.find = vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue(versions),
        }),
      });

      const res = await request(testServer()).get("/api/v1/profiles/p-1/versions");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(2);
    });
  });
});
