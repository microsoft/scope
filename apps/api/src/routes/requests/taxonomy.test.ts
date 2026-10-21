// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Unit tests for taxonomy download endpoints:
 *   - GET /api/v1/requests/:id/taxonomy
 *   - GET /api/v1/requests/:id/runs/:runId/taxonomy
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import supertest from "supertest";
import { app, _injectTestDependencies } from "../../index.js";
import { createAllMockDependencies } from "../../test-helpers.js";
import { readableFrom, rawParser, blobUrl, VARIANTS, RUN_LEVEL, rewireBlobMocks } from "./test-blob-helpers.js";

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

describe("taxonomy endpoints", () => {
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
    mockDownload.mockResolvedValue({ readableStreamBody: readableFrom('{"status":"ok"}'), contentLength: 15 });
    mockGetProperties.mockResolvedValue({ contentLength: 15 });
  });

  describe.each(VARIANTS)("$label", (variant) => {
    const taxonomyUrl = (id: string) => variant.url(id) + "taxonomy";

    it("returns 404 when request not found", async () => {
      (mocks.collection.findOne as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const res = await supertest(app).get(taxonomyUrl("missing"));
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "Request not found" });
    });

    it("returns 404 when taxonomyUrl is not set", async () => {
      variant.mockRequest(mocks, "req-1", { _id: "run-1", attemptNumber: 1, status: "done" });
      const res = await supertest(app).get(taxonomyUrl("req-1"));
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "Taxonomy not yet generated for this run" });
    });

    it("returns taxonomy JSON when taxonomyUrl is set", async () => {
      variant.mockRequest(mocks, "req-1", {
        _id: "run-1",
        attemptNumber: 1,
        status: "done",
        taxonomyUrl: blobUrl("req-1/taxonomy.json"),
      });

      const res = await supertest(app).get(taxonomyUrl("req-1")).buffer(true).parse(rawParser);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch("application/json");
      expect(res.headers["content-disposition"]).toContain("req-1-taxonomy.json");
      expect(mockGetBlockBlobClient).toHaveBeenCalledWith("req-1/taxonomy.json");
    });
  });

  it("works with per-run variant", async () => {
    RUN_LEVEL.mockRequest(mocks, "req-1", {
      _id: "run-1",
      attemptNumber: 1,
      status: "done",
      taxonomyUrl: blobUrl("req-1/runs/run-1/taxonomy.json"),
    });

    const res = await supertest(app).get(RUN_LEVEL.url("req-1") + "taxonomy").buffer(true).parse(rawParser);
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("req-1-taxonomy.json");
    expect(mockGetBlockBlobClient).toHaveBeenCalledWith("req-1/runs/run-1/taxonomy.json");
  });
});
