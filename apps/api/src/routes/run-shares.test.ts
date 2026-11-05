// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Readable } from "node:stream";
import type { Collection } from "mongodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { RestError } from "@azure/storage-blob";
import { AuthError } from "shared";
import { FULL_SHARE_CONTENT, RUN_SHARE_HEADER, SharedRunSchema, type RunShareLink } from "shared/run-sharing";
import { app, _injectTestDependencies } from "../index.js";
import { createAllMockDependencies } from "../test-helpers.js";
import { useTestServer } from "../test-server.js";
import { UserAccessError } from "../auth/user-access-resolver.js";
import { makeRequest, memoryShares, at, blobUrl } from "../run-sharing/test-fixtures.js";
import { MAX_SHARED_ARTIFACT_BYTES } from "../run-sharing/blob-access.js";

vi.mock("db-migrations/check-migrations", () => ({
  checkMigrations: vi.fn().mockResolvedValue({ ready: true }),
}));
vi.mock("../llm.js", () => ({ isLlmAvailable: vi.fn().mockReturnValue(false) }));
vi.mock("../prompt-feature-llm.js", () => ({ isLlmAvailable: vi.fn().mockReturnValue(false) }));
vi.mock("../task-prompt-llm.js", () => ({ isTaskPromptLlmAvailable: vi.fn().mockReturnValue(false) }));
vi.hoisted(() => {
  process.env.STORAGE_CONNECTION_STRING = "DefaultEndpointsProtocol=https;AccountName=mockaccount;AccountKey=bW9jaw==;EndpointSuffix=core.windows.net";
});
const blob = vi.hoisted(() => {
  const download = vi.fn();
  const properties = vi.fn();
  const getBlockBlobClient = vi.fn(() => ({ download, getProperties: properties }));
  const getContainerClient = vi.fn(() => ({ getBlockBlobClient }));
  return { download, properties, getBlockBlobClient, getContainerClient };
});
vi.mock("@azure/storage-blob", async (original) => ({
  ...await original<typeof import("@azure/storage-blob")>(),
  BlobServiceClient: { fromConnectionString: vi.fn(() => ({ getContainerClient: blob.getContainerClient })) },
}));

describe("public run sharing routes and authenticated lifecycle", () => {
  const server = useTestServer(app);
  let mocks: ReturnType<typeof createAllMockDependencies>;
  let shares: ReturnType<typeof memoryShares>;
  let source = makeRequest();
  const identity = { idp: "entra", idpTenant: "tenant", idpSubject: "subject" };
  const provider = { id: "entra", verifyAccessToken: vi.fn(async () => identity) };
  const resolver = {
    resolveExisting: vi.fn(async () => ({ id: "user-1", isAuthenticated: true, role: "user" })),
    enrollOnLogin: vi.fn(),
  };
  const path = "/api/v1/requests/request-1/runs/attempt-1/shares";
  const publicPath = "/api/v1/shared/runs";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("SCOPE_RUN_SHARING_ENABLED", "true");
    mocks = createAllMockDependencies();
    shares = memoryShares();
    source = makeRequest();
    vi.mocked(mocks.db.collection).mockReturnValue(shares.collection as unknown as Collection);
    vi.mocked(mocks.collection.findOne).mockImplementation(async () => source);
    vi.mocked(mocks.projectCollection.findOne).mockResolvedValue({ _id: "project-1", name: "Project", createdAt: at });
    provider.verifyAccessToken.mockResolvedValue(identity);
    resolver.resolveExisting.mockResolvedValue({ id: "user-1", isAuthenticated: true, role: "user" });
    _injectTestDependencies({ ...mocks, authProvider: provider, userAccessResolver: resolver });
    blob.properties.mockResolvedValue({ contentLength: 4 });
    blob.download.mockImplementation(async (offset = 0, count = 4) => ({
      readableStreamBody: Readable.from([Buffer.from("data").subarray(offset, offset + count)]),
      contentLength: count,
    }));
  });
  afterEach(() => vi.unstubAllEnvs());

  async function create(content: object = {}): Promise<RunShareLink> {
    const response = await request(server()).post(path).set("Authorization", "Bearer idp-token").send(content);
    expect(response.status).toBe(201);
    return response.body as RunShareLink;
  }
  const secret = (link: RunShareLink) => link.path.split("#")[1];

  it("allows ordinary active users to publish and signed-out recipients to read only the Summary projection", async () => {
    const link = await create();
    const response = await request(server()).get(`${publicPath}/view`).set(RUN_SHARE_HEADER, secret(link));
    expect(response.status).toBe(200);
    SharedRunSchema.parse(response.body);
    expect(JSON.stringify(response.body)).not.toMatch(/PRIVATE_|storage.example|tokenHash|createdBy|project-1|request-1/);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["x-robots-tag"]).toContain("noindex");
    expect(resolver.enrollOnLogin).not.toHaveBeenCalled();
    expect(provider.verifyAccessToken).toHaveBeenCalledTimes(1);
  });

  it("does not consult IdP credentials or the application user cache on public reads", async () => {
    const link = await create();
    provider.verifyAccessToken.mockClear();
    resolver.resolveExisting.mockClear();
    const response = await request(server()).get(`${publicPath}/view`)
      .set(RUN_SHARE_HEADER, secret(link)).set("Authorization", "Basic invalid");
    expect(response.status).toBe(200);
    expect(provider.verifyAccessToken).not.toHaveBeenCalled();
    expect(resolver.resolveExisting).not.toHaveBeenCalled();
    expect(resolver.enrollOnLogin).not.toHaveBeenCalled();
  });

  it("denies anonymous publication and disabled or unenrolled publishers without database writes", async () => {
    expect((await request(server()).post(path).send({})).status).toBe(401);
    resolver.resolveExisting.mockRejectedValueOnce(new UserAccessError("user_disabled"));
    expect((await request(server()).post(path).set("Authorization", "Bearer token").send({})).status).toBe(403);
    resolver.resolveExisting.mockRejectedValueOnce(new UserAccessError("user_not_enrolled"));
    expect((await request(server()).post(path).set("Authorization", "Bearer token").send({})).status).toBe(403);
    provider.verifyAccessToken.mockRejectedValueOnce(new AuthError("invalid_token", "Invalid"));
    expect((await request(server()).post(path).set("Authorization", "Bearer token").send({})).status).toBe(401);
    expect(shares.collection.insertOne).not.toHaveBeenCalled();
    expect(resolver.enrollOnLogin).not.toHaveBeenCalled();
  });

  it("requires explicit detailed-content confirmation and future expiry", async () => {
    for (const body of [{ content: FULL_SHARE_CONTENT }, { expiresAt: "2000-01-01T00:00:00.000Z" }, { content: { arbitrary: true } }]) {
      const response = await request(server()).post(path).set("Authorization", "Bearer token").send(body);
      expect(response.status).toBe(400);
    }
    expect(shares.collection.insertOne).not.toHaveBeenCalled();
  });

  it("enforces policy edits on every read and direct artifact URL", async () => {
    const link = await create({ content: FULL_SHARE_CONTENT, acknowledgeSensitiveContent: true });
    const token = secret(link);
    const view = await request(server()).get(`${publicPath}/view`).set(RUN_SHARE_HEADER, token);
    expect(view.body.run.turns[0].codingAgentResponse).toBe("PRIVATE_CONVERSATION");
    expect(view.body.prompts[0].text).toBe("PRIVATE_TASK");
    expect(view.body.prompts[1].text).toBe("PRIVATE_PERSONA");
    expect((await request(server()).get(`${publicPath}/artifacts/network`).set(RUN_SHARE_HEADER, token)).status).toBe(404);
    expect(blob.download).not.toHaveBeenCalled();
    await request(server()).patch(`${path}/${link.share.id}`).set("Authorization", "Bearer token")
      .send({ content: { ...link.share.content, evaluationDetails: false, prompts: false, conversations: false, logs: false, reports: false } }).expect(200);
    const restricted = await request(server()).get(`${publicPath}/view`).set(RUN_SHARE_HEADER, token);
    expect(JSON.stringify(restricted.body)).not.toContain("PRIVATE_");
    for (const resource of ["logs", "reports", "artifacts/conversation", "artifacts/iteration-1-snapshot"]) {
      expect((await request(server()).get(`${publicPath}/${resource}`).set(RUN_SHARE_HEADER, token)).status).toBe(404);
    }
  });

  it("pins historical attempts even after a retry and denies mismatched parent/project data", async () => {
    const link = await create();
    const original = source.run!;
    source = { ...source, run: { ...original, _id: "attempt-2", attemptNumber: 2 } };
    vi.mocked(mocks.runsCollection.findOne).mockResolvedValue({ ...original, requestId: "request-1", projectId: "project-1" });
    const response = await request(server()).get(`${publicPath}/view`).set(RUN_SHARE_HEADER, secret(link));
    expect(response.status).toBe(200);
    expect(response.body.run.attemptNumber).toBe(1);
    vi.mocked(mocks.runsCollection.findOne).mockResolvedValue({ ...original, requestId: "request-other", projectId: "project-1" });
    expect((await request(server()).get(`${publicPath}/view`).set(RUN_SHARE_HEADER, secret(link))).status).toBe(404);
    vi.mocked(mocks.runsCollection.findOne).mockResolvedValue({ ...original, requestId: "request-1", projectId: "other-project" });
    expect((await request(server()).get(`${publicPath}/view`).set(RUN_SHARE_HEADER, secret(link))).status).toBe(404);
  });

  it("makes invalid, expired, revoked, deleted, and disabled links indistinguishable", async () => {
    const link = await create();
    const token = secret(link);
    const invalid = await request(server()).get(`${publicPath}/view`).set(RUN_SHARE_HEADER, "bad");
    expect(invalid.status).toBe(404);
    const doc = shares.documents.get(link.share.id)!;
    doc.expiresAt = new Date(0);
    expect((await request(server()).get(`${publicPath}/view`).set(RUN_SHARE_HEADER, token)).body).toEqual(invalid.body);
    doc.expiresAt = null;
    source.deletedAt = at;
    expect((await request(server()).get(`${publicPath}/view`).set(RUN_SHARE_HEADER, token)).body).toEqual(invalid.body);
    delete source.deletedAt;
    vi.mocked(mocks.projectCollection.findOne).mockResolvedValueOnce({ _id: "project-1", deletedAt: at });
    expect((await request(server()).get(`${publicPath}/view`).set(RUN_SHARE_HEADER, token)).body).toEqual(invalid.body);
    await request(server()).delete(`${path}/${link.share.id}`).set("Authorization", "Bearer token").expect(200);
    expect((await request(server()).get(`${publicPath}/view`).set(RUN_SHARE_HEADER, token)).body).toEqual(invalid.body);
    vi.stubEnv("SCOPE_RUN_SHARING_ENABLED", "false");
    expect((await request(server()).get(`${publicPath}/view`).set(RUN_SHARE_HEADER, token)).body).toEqual(invalid.body);
    expect((await request(server()).post(path).set("Authorization", "Bearer token").send({})).status).toBe(404);
  });

  it("rotates secrets, hides them from lists, and denies management by other users", async () => {
    const link = await create();
    const listing = await request(server()).get(path).set("Authorization", "Bearer token");
    expect(listing.status).toBe(200);
    expect(listing.body.data).toHaveLength(1);
    expect(JSON.stringify(listing.body)).not.toMatch(/tokenHash|createdBy/);
    expect(JSON.stringify(listing.body)).not.toContain(secret(link));
    resolver.resolveExisting.mockResolvedValue({ id: "other-user", isAuthenticated: true, role: "user" });
    expect((await request(server()).get(path).set("Authorization", "Bearer token")).body.data).toHaveLength(0);
    for (const method of ["patch", "delete"] as const) {
      expect((await request(server())[method](`${path}/${link.share.id}`).set("Authorization", "Bearer token").send({ label: "stolen" })).status).toBe(404);
    }
    expect((await request(server()).post(`${path}/${link.share.id}/rotate`).set("Authorization", "Bearer token")).status).toBe(404);
    resolver.resolveExisting.mockResolvedValue({ id: "user-1", isAuthenticated: true, role: "user" });
    const rotated = await request(server()).post(`${path}/${link.share.id}/rotate`).set("Authorization", "Bearer token");
    expect(rotated.status).toBe(200);
    expect((await request(server()).get(`${publicPath}/view`).set(RUN_SHARE_HEADER, secret(link))).status).toBe(404);
    expect((await request(server()).get(`${publicPath}/view`).set(RUN_SHARE_HEADER, secret(rotated.body as RunShareLink))).status).toBe(200);
  });

  it("rejects public mutations, unknown child routes, and caller-selected IDs/paths", async () => {
    const link = await create();
    for (const resource of ["view", "retry", "cancel", "archive", "reports/request-other", "../private"]) {
      expect((await request(server()).post(`${publicPath}/${resource}`).set(RUN_SHARE_HEADER, secret(link))).status).toBe(404);
    }
    const response = await request(server()).get(`${publicPath}/view?requestId=request-other`).set(RUN_SHARE_HEADER, secret(link));
    expect(response.status).toBe(400);
    expect(blob.download).not.toHaveBeenCalled();
  });

  it("checks exact artifact permissions, verified blob paths, byte ranges, and size limits", async () => {
    const link = await create({
      content: { ...FULL_SHARE_CONTENT, video: true, network: true, snapshots: true },
      acknowledgeSensitiveContent: true,
    });
    const token = secret(link);
    await request(server()).get(`${publicPath}/artifacts/video-0`).set(RUN_SHARE_HEADER, token)
      .set("Range", "bytes=1-2").expect(206).expect("Content-Range", "bytes 1-2/4").expect("Content-Length", "2");
    expect(blob.download).toHaveBeenCalledWith(1, 2);
    blob.properties.mockResolvedValueOnce({ contentLength: MAX_SHARED_ARTIFACT_BYTES });
    await request(server()).head(`${publicPath}/artifacts/video-0`).set(RUN_SHARE_HEADER, token)
      .expect(200).expect("Content-Length", String(MAX_SHARED_ARTIFACT_BYTES));
    await request(server()).get(`${publicPath}/artifacts/video-0`).set(RUN_SHARE_HEADER, token).set("Range", "bytes=99-100").expect(416);
    blob.properties.mockResolvedValueOnce({ contentLength: MAX_SHARED_ARTIFACT_BYTES + 1 });
    await request(server()).get(`${publicPath}/artifacts/video-0`).set(RUN_SHARE_HEADER, token).expect(413);
    source.run!.videoUrls = [blobUrl("video.webm").replace("attempt-1", "other-attempt")];
    blob.download.mockClear();
    await request(server()).get(`${publicPath}/artifacts/video-0`).set(RUN_SHARE_HEADER, token).expect(404);
    expect(blob.download).not.toHaveBeenCalled();
  });

  it("returns safe JSON errors when an artifact disappears after its properties were read", async () => {
    const link = await create({ content: { ...FULL_SHARE_CONTENT, video: true }, acknowledgeSensitiveContent: true });
    blob.download.mockRejectedValueOnce(new RestError("PRIVATE_STORAGE_ERROR", { statusCode: 404 }));
    const missing = await request(server()).get(`${publicPath}/artifacts/video-0`).set(RUN_SHARE_HEADER, secret(link));
    expect(missing.status).toBe(404);
    expect(missing.headers["content-type"]).toContain("application/json");
    expect(JSON.stringify(missing.body)).not.toContain("PRIVATE_STORAGE_ERROR");
    expect(missing.headers["cache-control"]).toBe("no-store");
  });

  it("rejects public request bodies before JSON parsing or capability lookup", async () => {
    const before = vi.mocked(shares.collection.findOne).mock.calls.length;
    const response = await request(server()).get(`${publicPath}/view`).set("Content-Type", "application/json").send("{invalid");
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("do not accept a request body");
    expect(shares.collection.findOne).toHaveBeenCalledTimes(before);
  });

  it("serves bounded persisted logs without private SSE and scopes reports to verified attempts", async () => {
    const link = await create({ content: FULL_SHARE_CONTENT, acknowledgeSensitiveContent: true });
    const text = `${JSON.stringify({ timestamp: at.toISOString(), level: "info", message: "example log" })}\n`;
    blob.properties.mockResolvedValue({ contentLength: Buffer.byteLength(text) });
    blob.download.mockResolvedValue({ readableStreamBody: Readable.from([text]) });
    const logs = await request(server()).get(`${publicPath}/logs`).set(RUN_SHARE_HEADER, secret(link));
    expect(logs.status).toBe(200);
    expect(logs.body.events[0].message).toBe("example log");
    const reports = await request(server()).get(`${publicPath}/reports`).set(RUN_SHARE_HEADER, secret(link));
    expect(reports.status).toBe(200);
    expect(mocks.reportCollection.find).toHaveBeenCalledWith({
      requestId: "request-1", projectId: "project-1", runId: "attempt-1", sourceRunId: "attempt-1", status: "completed",
    });
  });
});
