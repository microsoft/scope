// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Unit tests for tool-calls JSONL download endpoints:
 *   - GET /api/v1/requests/:id/tool-calls
 *   - GET /api/v1/requests/:id/runs/:runId/tool-calls
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import supertest from "supertest";
import { app, _injectTestDependencies } from "../../index.js";
import { useTestServer } from "../../test-server.js";
import { createAllMockDependencies } from "../../test-helpers.js";
import { readableFrom, blobUrl, VARIANTS, rewireBlobMocks } from "./test-blob-helpers.js";

vi.mock("db-migrations/check-migrations", () => ({
  checkMigrations: vi.fn().mockResolvedValue({ ready: true, applied: ["001", "002"], pending: [] }),
}));

vi.hoisted(() => {
  process.env.STORAGE_CONNECTION_STRING = "DefaultEndpointsProtocol=https;AccountName=mockaccount;AccountKey=bW9jaw==;EndpointSuffix=core.windows.net";
});

vi.mock("../../llm.js", () => ({ isLlmAvailable: vi.fn().mockReturnValue(false) }));
vi.mock("../../prompt-feature-llm.js", () => ({ isLlmAvailable: vi.fn().mockReturnValue(false) }));
vi.mock("../../task-prompt-llm.js", () => ({ isTaskPromptLlmAvailable: vi.fn().mockReturnValue(false) }));

const { mockDownload, mockGetProperties, mockGetBlockBlobClient, mockGetBlobClient, mockGetContainerClient } = vi.hoisted(() => {
  const mockDownload = vi.fn();
  const mockGetProperties = vi.fn();
  const mockGetBlockBlobClient = vi.fn().mockReturnValue({ download: mockDownload, getProperties: mockGetProperties });
  const mockGetBlobClient = vi.fn().mockReturnValue({ download: mockDownload, getProperties: mockGetProperties });
  const mockGetContainerClient = vi.fn().mockReturnValue({ getBlockBlobClient: mockGetBlockBlobClient, getBlobClient: mockGetBlobClient });
  return { mockDownload, mockGetProperties, mockGetBlockBlobClient, mockGetBlobClient, mockGetContainerClient };
});

vi.mock("@azure/storage-blob", async (importOriginal) => {
  const original = await importOriginal<typeof import("@azure/storage-blob")>();
  return {
    ...original,
    BlobServiceClient: { fromConnectionString: vi.fn().mockReturnValue({ getContainerClient: mockGetContainerClient }) },
  };
});

describe("Tool-calls endpoints", () => {
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
    rewireBlobMocks({ mockDownload, mockGetProperties, mockGetBlockBlobClient, mockGetBlobClient, mockGetContainerClient });
    mockDownload.mockResolvedValue({ readableStreamBody: readableFrom("mock-blob-content"), contentLength: 17 });
    mockGetProperties.mockResolvedValue({ contentLength: 17 });
  });

  describe.each(VARIANTS)("$label", (variant) => {
    const tcUrl = (id: string, query = "") => variant.url(id) + `tool-calls${query}`;

    it("returns 404 when request not found", async () => {
      (mocks.collection.findOne as any).mockResolvedValue(null);
      const res = await supertest(testServer()).get(tcUrl("missing", "?iteration=1"));
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "Request not found" });
    });

    it("returns 400 when iteration query parameter is missing", async () => {
      variant.mockRequest(mocks, "req-1", { _id: "run-1", status: "done" });
      const res = await supertest(testServer()).get(tcUrl("req-1"));
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "iteration query parameter is required" });
    });

    it("returns 400 for invalid iteration number", async () => {
      variant.mockRequest(mocks, "req-1", { _id: "run-1", status: "done" });
      const res = await supertest(testServer()).get(tcUrl("req-1", "?iteration=0"));
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "Invalid iteration number" });
    });

    it("returns 404 when no tool-calls available for iteration", async () => {
      variant.mockRequest(mocks, "req-1", { _id: "run-1", status: "done", turns: [{ iteration: 1 }] });
      const res = await supertest(testServer()).get(tcUrl("req-1", "?iteration=1"));
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "No tool-calls JSONL available for this iteration" });
    });

    it("proxies tool-calls JSONL download", async () => {
      variant.mockRequest(mocks, "req-1", {
        _id: "run-1", status: "done",
        turns: [{ iteration: 1, toolCallsUrl: blobUrl("req-1/iter-1-tool-calls.jsonl") }],
      });

      const res = await supertest(testServer()).get(tcUrl("req-1", "?iteration=1"));
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch("application/x-ndjson");
      expect(res.headers["content-disposition"]).toContain("tool-calls.jsonl");
      expect(mockGetBlockBlobClient).toHaveBeenCalledWith("req-1/iter-1-tool-calls.jsonl");
    });
  });
});
