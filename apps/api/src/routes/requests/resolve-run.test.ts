// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Unit tests for resolveRunForRequest — the per-run resolution helper.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import supertest from "supertest";
import { app, _injectTestDependencies } from "../../index.js";
import { useTestServer } from "../../test-server.js";
import { createAllMockDependencies } from "../../test-helpers.js";
import { readableFrom, blobUrl, rewireBlobMocks } from "./test-blob-helpers.js";

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

describe("resolveRunForRequest (via per-run endpoints)", () => {
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

  it("returns 404 when request not found", async () => {
    (mocks.collection.findOne as any).mockResolvedValue(null);
    const res = await supertest(testServer()).get("/api/v1/requests/missing/runs/some-run/har");
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "Request not found" });
  });

  it("returns 404 when run is not found for the request", async () => {
    (mocks.collection.findOne as any).mockResolvedValue({
      _id: "req-1",
      run: { _id: "different-run", status: "done" },
    });
    (mocks.runsCollection.findOne as any).mockResolvedValue(null);

    const res = await supertest(testServer()).get("/api/v1/requests/req-1/runs/nonexistent/har");
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "Run not found for this request" });
  });

  it("resolves historical run from runs collection", async () => {
    (mocks.collection.findOne as any).mockResolvedValue({
      _id: "req-1",
      run: { _id: "current-run", status: "done" },
    });
    (mocks.runsCollection.findOne as any).mockResolvedValue({
      _id: "historical-run",
      requestId: "req-1",
      status: "done",
      harUrl: blobUrl("req-1/historical.har"),
    });
    mockDownload.mockResolvedValue({ readableStreamBody: readableFrom('{"log":{}}'), contentLength: 10 });

    const res = await supertest(testServer()).get("/api/v1/requests/req-1/runs/historical-run/har");
    expect(res.status).toBe(200);
    expect(mockGetBlockBlobClient).toHaveBeenCalledWith("req-1/historical.har");
  });

  it("rejects historical run belonging to a different request", async () => {
    (mocks.collection.findOne as any).mockResolvedValue({
      _id: "req-1",
      run: { _id: "current-run", status: "done" },
    });
    (mocks.runsCollection.findOne as any).mockResolvedValue({
      _id: "historical-run",
      requestId: "req-other",
      status: "done",
    });

    const res = await supertest(testServer()).get("/api/v1/requests/req-1/runs/historical-run/har");
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "Run not found for this request" });
  });
});
