// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Unit tests for HAR download endpoints:
 *   - GET /api/v1/requests/:id/har
 *   - GET /api/v1/requests/:id/runs/:runId/har
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import supertest from "supertest";
import { app, _injectTestDependencies } from "../../index.js";
import { useTestServer } from "../../test-server.js";
import { createAllMockDependencies } from "../../test-helpers.js";
import { readableFrom, rawParser, blobUrl, VARIANTS, rewireBlobMocks } from "./test-blob-helpers.js";

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

describe("HAR endpoints", () => {
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
    const harUrl = (id: string, query = "") => variant.url(id) + `har${query}`;

    it("returns 404 when request not found", async () => {
      (mocks.collection.findOne as any).mockResolvedValue(null);
      const res = await supertest(testServer()).get(harUrl("missing"));
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "Request not found" });
    });

    it("returns 404 when no HAR capture available", async () => {
      variant.mockRequest(mocks, "req-1", { _id: "run-1", status: "done" });
      const res = await supertest(testServer()).get(harUrl("req-1"));
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "No HAR capture available" });
    });

    it("proxies HAR download from run-level harUrl", async () => {
      variant.mockRequest(mocks, "req-1", { _id: "run-1", status: "done", harUrl: blobUrl("req-1/run.har") });
      mockDownload.mockResolvedValue({ readableStreamBody: readableFrom('{"log":{}}'), contentLength: 10 });

      const res = await supertest(testServer()).get(harUrl("req-1")).buffer(true).parse(rawParser);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch("application/json");
      expect(res.headers["content-disposition"]).toContain("req-1.har");
      expect(mockGetBlockBlobClient).toHaveBeenCalledWith("req-1/run.har");
    });

    it("proxies HAR download from per-iteration turn harUrl", async () => {
      variant.mockRequest(mocks, "req-1", {
        _id: "run-1", status: "done",
        turns: [
          { iteration: 1, harUrl: blobUrl("req-1/iter-1.har") },
          { iteration: 2, harUrl: blobUrl("req-1/iter-2.har") },
        ],
      });
      mockDownload.mockResolvedValue({ readableStreamBody: readableFrom('{"log":{}}'), contentLength: 10 });

      const res = await supertest(testServer()).get(harUrl("req-1", "?iteration=2")).buffer(true).parse(rawParser);
      expect(res.status).toBe(200);
      expect(res.headers["content-disposition"]).toContain("req-1-iteration-2.har");
      expect(mockGetBlockBlobClient).toHaveBeenCalledWith("req-1/iter-2.har");
    });

    it("returns 400 for invalid iteration number", async () => {
      variant.mockRequest(mocks, "req-1", { _id: "run-1", status: "done" });
      const res = await supertest(testServer()).get(harUrl("req-1", "?iteration=abc"));
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "Invalid iteration number" });
    });

    it("falls back to last turn harUrl when no run-level harUrl", async () => {
      variant.mockRequest(mocks, "req-1", {
        _id: "run-1", status: "done",
        turns: [
          { iteration: 1, harUrl: blobUrl("req-1/iter-1.har") },
          { iteration: 2, harUrl: blobUrl("req-1/iter-2.har") },
        ],
      });
      mockDownload.mockResolvedValue({ readableStreamBody: readableFrom('{"log":{}}'), contentLength: 10 });

      const res = await supertest(testServer()).get(harUrl("req-1")).buffer(true).parse(rawParser);
      expect(res.status).toBe(200);
      expect(mockGetBlockBlobClient).toHaveBeenCalledWith("req-1/iter-2.har");
    });
  });
});
