// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Unit tests for video download endpoints:
 *   - GET /api/v1/requests/:id/video
 *   - GET /api/v1/requests/:id/runs/:runId/video
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

describe("Video endpoints", () => {
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
    const vidUrl = (id: string, query = "") => variant.url(id) + `video${query}`;

    it("returns 404 when request not found", async () => {
      (mocks.collection.findOne as any).mockResolvedValue(null);
      const res = await supertest(testServer()).get(vidUrl("missing"));
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "Request not found" });
    });

    it("returns 404 when no video recordings available", async () => {
      variant.mockRequest(mocks, "req-1", { _id: "run-1", status: "done" });
      const res = await supertest(testServer()).get(vidUrl("req-1"));
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "No video recordings available" });
    });

    it("proxies video download from run-level videoUrls", async () => {
      variant.mockRequest(mocks, "req-1", { _id: "run-1", status: "done", videoUrls: [blobUrl("req-1/video-0.webm")] });

      const res = await supertest(testServer()).get(vidUrl("req-1"));
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch("video/webm");
      expect(res.headers["accept-ranges"]).toBe("bytes");
      expect(mockGetBlockBlobClient).toHaveBeenCalledWith("req-1/video-0.webm");
    });

    it("proxies video from per-iteration turn", async () => {
      variant.mockRequest(mocks, "req-1", {
        _id: "run-1", status: "done",
        turns: [{ iteration: 1, videoUrls: [blobUrl("req-1/iter-1-video-0.webm")] }],
      });

      const res = await supertest(testServer()).get(vidUrl("req-1", "?iteration=1"));
      expect(res.status).toBe(200);
      expect(mockGetBlockBlobClient).toHaveBeenCalledWith("req-1/iter-1-video-0.webm");
    });

    it("proxies setup video", async () => {
      variant.mockRequest(mocks, "req-1", { _id: "run-1", status: "done", setupVideoUrls: [blobUrl("req-1/setup-video-0.webm")] });

      const res = await supertest(testServer()).get(vidUrl("req-1", "?phase=setup"));
      expect(res.status).toBe(200);
      expect(mockGetBlockBlobClient).toHaveBeenCalledWith("req-1/setup-video-0.webm");
    });

    it("returns 404 when video index is out of range", async () => {
      variant.mockRequest(mocks, "req-1", { _id: "run-1", status: "done", videoUrls: [blobUrl("req-1/video-0.webm")] });

      const res = await supertest(testServer()).get(vidUrl("req-1", "?index=5"));
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("Video index 5 not found");
    });

    it("returns 400 for invalid video index", async () => {
      variant.mockRequest(mocks, "req-1", { _id: "run-1", status: "done" });
      const res = await supertest(testServer()).get(vidUrl("req-1", "?index=-1"));
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "Invalid video index" });
    });

    it("supports Range requests for video seeking", async () => {
      variant.mockRequest(mocks, "req-1", { _id: "run-1", status: "done", videoUrls: [blobUrl("req-1/video-0.webm")] });
      mockGetProperties.mockResolvedValue({ contentLength: 1000 });

      const partialBody = "a]".repeat(250); // 500 bytes
      mockDownload.mockResolvedValue({ readableStreamBody: readableFrom(partialBody), contentLength: 500 });

      const res = await supertest(testServer())
        .get(vidUrl("req-1"))
        .set("Range", "bytes=0-499")
        .buffer(true)
        .parse(rawParser);

      expect(res.status).toBe(206);
      expect(res.headers["content-range"]).toBe("bytes 0-499/1000");
      expect(res.headers["content-length"]).toBe("500");
      expect(mockDownload).toHaveBeenCalledWith(0, 500);
    });

    it("returns 400 for invalid iteration number", async () => {
      variant.mockRequest(mocks, "req-1", { _id: "run-1", status: "done" });
      const res = await supertest(testServer()).get(vidUrl("req-1", "?iteration=abc"));
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "Invalid iteration number" });
    });
  });
});
