// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Unit tests for video download endpoints:
 *   - GET /api/v1/requests/:id/video
 *   - GET /api/v1/requests/:id/runs/:runId/video
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { PassThrough } from "node:stream";
import { get } from "node:http";
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
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["content-length"]).toBe("17");
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
      expect(mockDownload).toHaveBeenCalledWith(0, 500, { abortSignal: expect.any(AbortSignal) });
    });

    it.each([
      ["bytes=5-", 5, 16],
      ["bytes=-5", 12, 16],
      ["bytes=10-9999", 10, 16],
      ["bytes=-9999", 0, 16],
    ])("honors the bounded range %s", async (header, start, end) => {
      variant.mockRequest(mocks, "req-1", { _id: "run-1", status: "done", videoUrls: [blobUrl("req-1/video-0.webm")] });
      mockDownload.mockResolvedValue({ readableStreamBody: readableFrom("a".repeat(end - start + 1)) });
      const res = await supertest(testServer()).get(vidUrl("req-1")).set("Range", header).buffer(true).parse(rawParser);
      expect(res.status).toBe(206);
      expect(res.headers["content-range"]).toBe(`bytes ${start}-${end}/17`);
      expect(res.headers["content-length"]).toBe(String(end - start + 1));
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(mockDownload).toHaveBeenCalledWith(start, end - start + 1, { abortSignal: expect.any(AbortSignal) });
    });

    it.each(["bytes=17-", "bytes=9-2", "bytes=-0", "bytes=-", "bytes=0-1,3-4", "junk bytes=0-1", "bytes=9007199254740992-"])(
      "rejects an invalid or unsatisfiable range %s without downloading", async header => {
        variant.mockRequest(mocks, "req-1", { _id: "run-1", status: "done", videoUrls: [blobUrl("req-1/video-0.webm")] });
        const res = await supertest(testServer()).get(vidUrl("req-1")).set("Range", header);
        expect(res.status).toBe(416);
        expect(res.headers["content-range"]).toBe("bytes */17");
        expect(res.headers["accept-ranges"]).toBe("bytes");
        expect(mockDownload).not.toHaveBeenCalled();
      },
    );

    it("returns 416 for a range on an empty recording", async () => {
      variant.mockRequest(mocks, "req-1", { _id: "run-1", status: "done", videoUrls: [blobUrl("req-1/video-0.webm")] });
      mockGetProperties.mockResolvedValue({ contentLength: 0 });
      const res = await supertest(testServer()).get(vidUrl("req-1")).set("Range", "bytes=0-");
      expect(res.status).toBe(416);
      expect(res.headers["content-range"]).toBe("bytes */0");
      expect(mockDownload).not.toHaveBeenCalled();
    });

    it("returns 400 for invalid iteration number", async () => {
      variant.mockRequest(mocks, "req-1", { _id: "run-1", status: "done" });
      const res = await supertest(testServer()).get(vidUrl("req-1", "?iteration=abc"));
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "Invalid iteration number" });
    });

    it.each(["index=1junk", "index=0.5", "index=9007199254740992", "index=1&index=0", "iteration=1junk", "iteration=0", "phase=unknown"])(
      "rejects an ambiguous video selector %s", async query => {
        variant.mockRequest(mocks, "req-1", { _id: "run-1", status: "done", videoUrls: [blobUrl("req-1/video-0.webm")] });
        const res = await supertest(testServer()).get(vidUrl("req-1", `?${query}`));
        expect(res.status).toBe(400);
        expect(res.headers["cache-control"]).toBe("no-store");
        expect(mockDownload).not.toHaveBeenCalled();
      },
    );

    it("aborts blob streaming when the native player disconnects during a range", async () => {
      variant.mockRequest(mocks, "req-1", { _id: "run-1", status: "done", videoUrls: [blobUrl("req-1/video-0.webm")] });
      const body = new PassThrough();
      let upstreamSignal: AbortSignal | undefined;
      mockDownload.mockImplementation(async (_start, _count, options: { abortSignal: AbortSignal }) => {
        upstreamSignal = options.abortSignal;
        return { readableStreamBody: body };
      });
      const address = testServer().address();
      if (!address || typeof address === "string") throw new Error("Test server has no TCP address.");
      const request = get({
        hostname: "127.0.0.1", port: address.port, path: vidUrl("req-1"), headers: { Range: "bytes=0-16" },
      });
      const received = new Promise<void>((resolve, reject) => {
        request.once("error", reject);
        request.once("response", response => response.once("data", () => resolve()));
      });
      try {
        await vi.waitFor(() => expect(upstreamSignal).toBeDefined());
        body.write("first");
        await received;
        request.destroy();
        await vi.waitFor(() => expect(upstreamSignal?.aborted).toBe(true));
        await vi.waitFor(() => expect(body.destroyed).toBe(true));
      } finally {
        request.destroy();
        body.destroy();
      }
    });
  });
});
