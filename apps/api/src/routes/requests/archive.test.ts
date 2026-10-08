// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Round-trip + validation tests for the run import/export feature:
 *   - GET  /api/v1/requests/:id/archive   (export)
 *   - POST /api/v1/runs/upload            (import)
 *
 * Both Mongo (`ctx.requestCollection`) and Azure Blob storage are mocked
 * in-memory, so this is a pure unit test — no real services required.
 *
 * Goals:
 *   1. Round-trip: export → import → assert the re-inserted document
 *      preserves the run's identity, scenario, status, and iteration data.
 *   2. Validation: malformed archives are rejected with the right HTTP code.
 *   3. Conflict: duplicate _id returns 409 (rather than silently replacing).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { OpenAPIRegistry, extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { Readable } from "stream";
import { gzipSync, gunzipSync } from "zlib";
import { pack as tarPack, extract as tarExtract } from "tar-stream";
import { RestError } from "@azure/storage-blob";
import { computeTaskPromptId } from "shared";

const TEST_PROJECT_ID = "test-project";

extendZodWithOpenApi(z);

// ─── In-memory blob store ───────────────────────────────────────────────────
//
// Map of "<container>/<blobName>" → Buffer. The mocked
// `BlobServiceClient.fromConnectionString(...)` returns a façade that reads
// and writes through this map, so the upload handler's hard-coded
// `BlobServiceClient.fromConnectionString(...)` call is intercepted without
// touching `ctx.blobStorage` (which the handler bypasses today).

const blobStore = new Map<string, Buffer>();
const ACCOUNT_HOST = "https://test.blob.core.windows.net";

function blobUrl(container: string, name: string): string {
  return `${ACCOUNT_HOST}/${container}/${name}`;
}

function makeBlockBlobClient(container: string, name: string) {
  const key = `${container}/${name}`;
  return {
    url: blobUrl(container, name),
    async download() {
      const buf = blobStore.get(key);
      if (!buf) {
        // Mirror the @azure/storage-blob RestError shape used by the routes.
        // Routes check `err instanceof RestError` to distinguish 404s from
        // hard failures, so a plain Error would surface as a 500.
        throw new RestError(`Blob not found: ${key}`, {
          statusCode: 404,
          code: "BlobNotFound",
        });
      }
      return {
        contentLength: buf.length,
        readableStreamBody: Readable.from([buf]),
      };
    },
    async uploadFile(localPath: string) {
      // The upload handler writes the iteration tar.gz to a tmp file then
      // calls uploadFile(path). Read it from disk and stash in memory.
      const { readFileSync } = await import("fs");
      blobStore.set(key, readFileSync(localPath));
    },
    async uploadStream(stream: NodeJS.ReadableStream, _bufferSize?: number, _maxConcurrency?: number, opts?: { conditions?: { ifNoneMatch?: string } }) {
      // Honor If-None-Match: "*" → fail if the blob already exists. The
      // import pipeline relies on this to refuse clobbering an existing
      // run's data when a duplicate `_id` is uploaded.
      if (opts?.conditions?.ifNoneMatch === "*" && blobStore.has(key)) {
        throw new RestError(`Blob already exists: ${key}`, {
          statusCode: 412,
          code: "BlobAlreadyExists",
        });
      }
      // Streaming upload — consume the Readable into a Buffer and stash.
      const chunks: Buffer[] = [];
      for await (const c of stream as AsyncIterable<Buffer | string>) {
        chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      }
      blobStore.set(key, Buffer.concat(chunks));
    },
    async upload(data: Buffer | string, length: number) {
      const buf = typeof data === "string" ? Buffer.from(data) : data;
      blobStore.set(key, buf.subarray(0, length));
    },
    async deleteIfExists() {
      const existed = blobStore.delete(key);
      return { succeeded: existed };
    },
  };
}

function makeContainerClient(container: string) {
  return {
    async createIfNotExists() {
      /* no-op */
    },
    getBlockBlobClient(name: string) {
      return makeBlockBlobClient(container, name);
    },
    getBlobClient(name: string) {
      return makeBlockBlobClient(container, name);
    },
    getAppendBlobClient(name: string) {
      // Delegate to the same façade as block-blobs so importer code that
      // writes via getBlockBlobClient and reader code that downloads via
      // getAppendBlobClient share a single in-memory blob. BlobStorage's
      // getLogsBlobUrl also calls this purely for the `.url` field.
      return makeBlockBlobClient(container, name);
    },
  };
}

const fakeBlobServiceClient = {
  getContainerClient(name: string) {
    return makeContainerClient(name);
  },
};

vi.mock("@azure/storage-blob", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@azure/storage-blob")>();
  return {
    ...actual,
    BlobServiceClient: {
      fromConnectionString: vi.fn(() => fakeBlobServiceClient),
    },
  };
});

vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: vi.fn(),
}));

// Imports that depend on the mocked modules must come after `vi.mock`.
const { registerRequestsRoutes } = await import("./index.js");
const { registerRequestsArchiveRoutes } = await import("./archive.js");

// ─── In-memory Mongo collection ─────────────────────────────────────────────

function makeRequestCollection() {
  const docs = new Map<string, any>();
  return {
    docs,
    findOne: vi.fn(async (filter: any) => {
      if (filter?._id) return docs.get(filter._id) ?? null;
      if (filter?._id?.$in) {
        for (const id of filter._id.$in) {
          const d = docs.get(id);
          if (d) return d;
        }
        return null;
      }
      return null;
    }),
    insertOne: vi.fn(async (doc: any) => {
      docs.set(doc._id, doc);
      return { acknowledged: true, insertedId: doc._id };
    }),
    find: vi.fn((filter: any) => ({
      toArray: async () => {
        if (filter?._id?.$in) {
          return filter._id.$in.map((id: string) => docs.get(id)).filter(Boolean);
        }
        return Array.from(docs.values());
      },
    })),
    watch: vi.fn(),
    deleteOne: vi.fn(async () => ({ deletedCount: 1 })),
    updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
  };
}

// ─── Helpers to build a tar.gz the upload handler can consume ──────────────

/** Builds a gzipped tar buffer from a flat map of entryName → content. */
async function buildTarGz(entries: Record<string, Buffer | string>): Promise<Buffer> {
  const pack = tarPack();
  for (const [name, content] of Object.entries(entries)) {
    const buf = typeof content === "string" ? Buffer.from(content) : content;
    pack.entry({ name, size: buf.length }, buf);
  }
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const c of pack as any) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return gzipSync(Buffer.concat(chunks));
}

/** Lists entry names + decoded contents from a tar.gz buffer. */
async function readTarGz(buf: Buffer): Promise<Record<string, Buffer>> {
  const out: Record<string, Buffer> = {};
  const ext = tarExtract();
  const inflated = gunzipSync(buf);
  return await new Promise((resolve, reject) => {
    ext.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        out[header.name] = Buffer.concat(chunks);
        next();
      });
      stream.resume();
    });
    ext.on("finish", () => resolve(out));
    ext.on("error", reject);
    Readable.from([inflated]).pipe(ext);
  });
}

// ─── App harness ────────────────────────────────────────────────────────────

function makeTaskPromptStore() {
  // Content-addressed in-memory implementation that mirrors the production
  // TaskPromptStore.findOrCreate semantics: same text always resolves to
  // the same UUIDv5 and the document is created on first sight, returned
  // on subsequent calls. The importer relies on this to materialize a
  // task-prompt entity for every imported run.
  const docs = new Map<string, { _id: string; text: string; createdAt: Date }>();
  return {
    docs,
    findOrCreate: vi.fn(async (_projectId: string, text: string) => {
      const trimmed = text.trim();
      const id = computeTaskPromptId(trimmed);
      const existing = docs.get(id);
      if (existing) return existing;
      const doc = { _id: id, text: trimmed, createdAt: new Date() };
      docs.set(id, doc);
      return doc;
    }),
    get: vi.fn(async (id: string) => docs.get(id) ?? null),
  };
}

function buildApp(
  reqCollection: ReturnType<typeof makeRequestCollection>,
  taskPromptStore: ReturnType<typeof makeTaskPromptStore> = makeTaskPromptStore(),
): Express {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  const ctx: any = {
    app,
    registry: new OpenAPIRegistry(),
    requestCollection: reqCollection,
    runsCollection: { findOne: vi.fn(), find: vi.fn(() => ({ toArray: async () => [] })) },
    // Stubs — none of these are touched by the archive/upload code paths.
    db: {} as any,
    criteriaCollection: {} as any,
    promptFeatureCollection: {} as any,
    reportCollection: {} as any,
    reportTemplateCollection: {} as any,
    agentCollection: {} as any,
    modelCollection: {} as any,
    mcpServerCollection: {} as any,
    insightsCollection: {} as any,
    taskPromptCollection: {} as any,
    featureFlagCollection: {} as any,
    skillCollection: {} as any,
    extensionCollection: {} as any,
    skillRevisionCollection: {} as any,
    profileCollection: {} as any,
    profileVersionCollection: {} as any,
    taskPromptStore,
    skillRevisionStore: {} as any,
    skillResolver: {} as any,
    mcpSecretClient: null,
    reportQueueClient: {} as any,
    blobStorage: {
      getLogsBlobUrl: (name: string) => blobUrl("logs", name),
    },
    strictAgentCapabilities: false,
    storageConnectionString: "UseDevelopmentStorage=true",
    storageAccountName: "test",
  };

  registerRequestsRoutes(ctx);
  registerRequestsArchiveRoutes(ctx);

  // Generic error handler so unhandled throws surface as 500.
  app.use((err: Error, _req: any, res: any, _next: any) => {
    res.status(500).json({ error: err.message });
  });

  return app;
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

function makeFixtureRun(id = "run-fixture-1") {
  // A minimal but realistic terminal run document. Per migration 014,
  // per-attempt fields live under `run.*` (status, turns, harUrl, …).
  return {
    _id: id,
    projectId: TEST_PROJECT_ID,
    scenario: { task: "echo hello", criteria: ["c1"] },
    workerType: "coder-acp-copilot",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    priority: 0,
    submissionId: "submission-abc",
    run: {
      _id: id,
      attemptNumber: 1,
      status: "done",
      outcome: "succeeded",
      logsUrl: blobUrl("logs", `${id}/runs/${id}/run.jsonl`),
      turns: [
        {
          iteration: 1,
          timestamp: new Date("2026-01-01T00:01:00Z"),
          snapshotUrl: blobUrl("snapshots", `${id}/iteration-1/workspace.tar.gz`),
          judgeFeedback: "looks good",
          passed: true,
        },
      ],
    },
  };
}

beforeEach(() => {
  blobStore.clear();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("run import/export — validation (POST /api/v1/runs/upload)", () => {
  it("returns 400 when run.yaml is missing", async () => {
    const app = buildApp(makeRequestCollection());
    // A subdir without run.yaml inside — pipeline ingests no artifacts and
    // the finalize step rejects the empty subdir.
    const archive = await buildTarGz({ "orphan/junk.txt": "no run here" });

    const res = await request(app)
      .post(`/api/v1/runs/upload?projectId=${TEST_PROJECT_ID}`)
      .attach("archive", archive, "archive.tar.gz");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/run\.yaml/i);
  });

  it("returns 400 when run.yaml is missing _id", async () => {
    const app = buildApp(makeRequestCollection());
    const archive = await buildTarGz({
      "run/run.yaml":
        "projectId: test-project\nscenario:\n  task: hi\nworkerType: coder-acp-copilot\nrun:\n  status: done\n",
    });

    const res = await request(app)
      .post(`/api/v1/runs/upload?projectId=${TEST_PROJECT_ID}`)
      .attach("archive", archive, "archive.tar.gz");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/_id/);
  });

  it("returns 400 for in-flight (non-terminal) runs", async () => {
    const app = buildApp(makeRequestCollection());
    const archive = await buildTarGz({
      // Subdir name must match the run.yaml _id — the importer enforces this
      // since blob URLs are derived from the prefix before run.yaml is parsed.
      "in-flight-1/run.yaml":
        "_id: in-flight-1\nprojectId: test-project\nscenario:\n  task: t\n  criteria: []\nworkerType: coder-acp-copilot\ncreatedAt: 2026-01-01T00:00:00Z\nrun:\n  _id: in-flight-1\n  attemptNumber: 1\n  status: processing\n",
    });

    const res = await request(app)
      .post(`/api/v1/runs/upload?projectId=${TEST_PROJECT_ID}`)
      .attach("archive", archive, "archive.tar.gz");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/in-flight|terminal/i);
  });

  it("returns 409 when a run with the same _id already exists", async () => {
    const reqs = makeRequestCollection();
    reqs.docs.set("dup-1", { _id: "dup-1", run: { status: "done" } });
    const app = buildApp(reqs);

    const archive = await buildTarGz({
      "dup-1/run.yaml":
        "_id: dup-1\nprojectId: test-project\nscenario:\n  task: t\n  criteria: []\nworkerType: coder-acp-copilot\ncreatedAt: 2026-01-01T00:00:00Z\nrun:\n  _id: dup-1\n  attemptNumber: 1\n  status: done\n",
    });

    const res = await request(app)
      .post(`/api/v1/runs/upload?projectId=${TEST_PROJECT_ID}`)
      .attach("archive", archive, "archive.tar.gz");

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  it("returns 400 with structured details when run.yaml fails schema validation", async () => {
    const app = buildApp(makeRequestCollection());

    // scenario.criteria must be string[]; sending number[] is a type
    // violation that the legacy presence checks would have missed.
    const archive = await buildTarGz({
      "bad/run.yaml":
        "_id: bad-1\nprojectId: test-project\nscenario:\n  task: t\n  criteria: [1, 2]\nworkerType: coder-acp-copilot\ncreatedAt: 2026-01-01T00:00:00Z\nrun:\n  _id: bad-1\n  attemptNumber: 1\n  status: done\n",
    });

    const res = await request(app)
      .post(`/api/v1/runs/upload?projectId=${TEST_PROJECT_ID}`)
      .attach("archive", archive, "archive.tar.gz");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/run\.yaml/i);
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: expect.stringMatching(/scenario\.criteria/) }),
      ]),
    );
  });

  it("cleans up uploaded blobs when run.yaml fails schema validation", async () => {
    // Pre-condition: blob store starts empty (beforeEach clears it).
    const app = buildApp(makeRequestCollection());

    // Archive carries a real iteration tarball alongside an invalid yaml.
    // The streaming pipeline uploads the iteration blob *before* finalize
    // gets a chance to validate the yaml — so the only thing standing
    // between us and an orphan is cleanupRunBlobs in the finalize catch.
    const innerIterTar = await buildTarGz({ "hello.txt": "iter-1 contents" });
    const archive = await buildTarGz({
      "bad-cleanup/run.yaml":
        "_id: bad-cleanup\nprojectId: test-project\nscenario:\n  task: t\n  criteria: [1, 2]\nworkerType: coder-acp-copilot\ncreatedAt: 2026-01-01T00:00:00Z\nrun:\n  _id: bad-cleanup\n  attemptNumber: 1\n  status: done\n",
      "bad-cleanup/iteration-1.tar.gz": innerIterTar,
    });

    const res = await request(app)
      .post(`/api/v1/runs/upload?projectId=${TEST_PROJECT_ID}`)
      .attach("archive", archive, "archive.tar.gz");

    expect(res.status).toBe(400);
    // The iteration blob was uploaded mid-stream, but the finalize-time
    // schema rejection must have triggered cleanupRunBlobs and deleted it.
    expect(blobStore.has("snapshots/bad-cleanup/iteration-1/workspace.tar.gz")).toBe(false);
    // Belt and braces: nothing else got left behind under that prefix.
    for (const key of blobStore.keys()) {
      expect(key.includes("bad-cleanup")).toBe(false);
    }
  });

  it("does not clobber existing run blobs when uploading a duplicate _id", async () => {
    // Pre-seed Mongo + blob store as if `dup-noclob` had been imported
    // previously. The retry archive contains *different* iteration bytes;
    // the ifNoneMatch guard on uploadStream must refuse to overwrite, and
    // the per-run cleanup must not delete the existing blob either.
    const reqs = makeRequestCollection();
    reqs.docs.set("dup-noclob", { _id: "dup-noclob", run: { status: "done" } });
    const app = buildApp(reqs);

    const originalIterBytes = Buffer.from("ORIGINAL iteration contents");
    const originalBlobKey = "snapshots/dup-noclob/iteration-1/workspace.tar.gz";
    blobStore.set(originalBlobKey, originalIterBytes);

    const replacementIterTar = await buildTarGz({ "evil.txt": "REPLACEMENT bytes" });
    const archive = await buildTarGz({
      "dup-noclob/run.yaml":
        "_id: dup-noclob\nprojectId: test-project\nscenario:\n  task: t\n  criteria: []\nworkerType: coder-acp-copilot\ncreatedAt: 2026-01-01T00:00:00Z\nrun:\n  _id: dup-noclob\n  attemptNumber: 1\n  status: done\n",
      "dup-noclob/iteration-1.tar.gz": replacementIterTar,
    });

    const res = await request(app)
      .post(`/api/v1/runs/upload?projectId=${TEST_PROJECT_ID}`)
      .attach("archive", archive, "archive.tar.gz");

    // Status may be 409 (Mongo dup wins the race) or 500 (uploadStream's
    // 412 surfaces as a per-run upload failure first). Either way the
    // critical invariant is the existing blob bytes are untouched.
    expect([409, 500]).toContain(res.status);
    expect(blobStore.get(originalBlobKey)).toEqual(originalIterBytes);
  });
});

describe("run import/export — round-trip (export → import)", () => {
  it("exports a run and re-imports it preserving identity, scenario, and iterations", async () => {
    const fixture = makeFixtureRun("rt-1");

    // Source side: seed Mongo with the run, and seed blob store with the
    // iteration snapshot the export endpoint will stream into the archive.
    const sourceReqs = makeRequestCollection();
    sourceReqs.docs.set(fixture._id, fixture);
    const innerIterTar = await buildTarGz({ "hello.txt": "iteration-1 contents" });
    blobStore.set(`snapshots/${fixture._id}/iteration-1/workspace.tar.gz`, innerIterTar);

    // 1. Export
    const exportApp = buildApp(sourceReqs);
    const exportRes = await request(exportApp)
      .get(`/api/v1/requests/${fixture._id}/archive`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    expect(exportRes.status).toBe(200);
    expect(exportRes.headers["content-type"]).toMatch(/gzip/);
    const archiveBuf: Buffer = exportRes.body;
    expect(archiveBuf.length).toBeGreaterThan(0);

    // Verify the archive layout the importer must accept.
    const entries = await readTarGz(archiveBuf);
    expect(Object.keys(entries)).toEqual(
      expect.arrayContaining([`${fixture._id}/run.yaml`, `${fixture._id}/iteration-1.tar.gz`]),
    );

    // 2. Import into a fresh app + Mongo. Blob store is cleared so the
    // iteration must come purely from the archive bytes.
    blobStore.clear();
    const targetReqs = makeRequestCollection();
    const importApp = buildApp(targetReqs);

    const importRes = await request(importApp)
      .post(`/api/v1/runs/upload?projectId=${TEST_PROJECT_ID}`)
      .attach("archive", archiveBuf, "archive.tar.gz");

    expect(importRes.status).toBe(201);
    expect(importRes.body.id).toBe(fixture._id);
    expect(importRes.body.iterations).toBe(1);

    // 3. Assert the re-inserted document mirrors the original.
    const reinserted = targetReqs.docs.get(fixture._id);
    expect(reinserted).toBeDefined();
    expect(reinserted._id).toBe(fixture._id);
    expect(reinserted.workerType).toBe(fixture.workerType);
    expect(reinserted.scenario).toEqual(fixture.scenario);
    expect(reinserted.run.status).toBe("done");
    expect(reinserted.run.outcome).toBe("succeeded");
    expect(reinserted.run.turns).toHaveLength(1);
    expect(reinserted.run.turns[0].iteration).toBe(1);
    // snapshotUrl should be rebuilt under the new run, pointing at the
    // re-uploaded iteration blob.
    expect(reinserted.run.turns[0].snapshotUrl).toMatch(
      new RegExp(`/snapshots/${fixture._id}/iteration-1/workspace\\.tar\\.gz$`),
    );
    // The iteration blob payload must have actually been re-uploaded.
    const reuploaded = blobStore.get(`snapshots/${fixture._id}/iteration-1/workspace.tar.gz`);
    expect(reuploaded).toBeDefined();
    expect(reuploaded!.length).toBeGreaterThan(0);
  });

  it("round-trips per-iteration HAR, chat-export and tool-calls plus run-level HAR/chat-export", async () => {
    const id = "rt-blobs";
    const fixture: any = makeFixtureRun(id);

    // Wire URLs onto the run + turn so packRunIntoTar pulls each blob into
    // the archive. URLs only need the `/snapshots/` (or `/logs/`) marker —
    // blobNameFromSnapshotsUrl strips everything before that prefix.
    fixture.run.harUrl = blobUrl("snapshots", `${id}/run.har`);
    fixture.run.rawChatUrl = blobUrl("snapshots", `${id}/run.chat-export.json`);
    fixture.run.logsUrl = blobUrl("logs", `${id}/runs/${id}/run.jsonl`);
    fixture.run.turns[0].harUrl = blobUrl("snapshots", `${id}/iteration-1/network.har`);
    fixture.run.turns[0].rawChatUrl = blobUrl("snapshots", `${id}/iteration-1/chat-export.json`);
    fixture.run.turns[0].chatResultUrl = blobUrl("snapshots", `${id}/iteration-1/chat-result.json`);
    fixture.run.turns[0].toolCallsUrl = blobUrl("snapshots", `${id}/iteration-1/tool-calls.jsonl`);

    // Seed source blobs. Contents are arbitrary bytes — the export/import
    // pipeline treats every file as opaque, so a marker string per slot is
    // enough to assert byte-equal round-trip.
    const innerIterTar = await buildTarGz({ "hello.txt": "iteration-1" });
    const blobs: Record<string, Buffer> = {
      [`snapshots/${id}/iteration-1/workspace.tar.gz`]: innerIterTar,
      [`snapshots/${id}/iteration-1/network.har`]: Buffer.from('{"log":{"entries":[]}}'),
      [`snapshots/${id}/run.har`]: Buffer.from('{"log":{"top":true}}'),
      [`snapshots/${id}/iteration-1/chat-export.json`]: Buffer.from('{"chat":"per-iter"}'),
      [`snapshots/${id}/run.chat-export.json`]: Buffer.from('{"chat":"top"}'),
      [`snapshots/${id}/iteration-1/chat-result.json`]: Buffer.from('{"result":"per-iter"}'),
      [`snapshots/${id}/iteration-1/tool-calls.jsonl`]: Buffer.from('{"tool":"a"}\n{"tool":"b"}\n'),
      [`logs/${id}/runs/${id}/run.jsonl`]: Buffer.from('{"level":"info","message":"hi"}\n'),
    };
    for (const [k, v] of Object.entries(blobs)) blobStore.set(k, v);

    const sourceReqs = makeRequestCollection();
    sourceReqs.docs.set(id, fixture);

    // 1. Export and verify every artifact lands in the archive byte-equal.
    const exportApp = buildApp(sourceReqs);
    const exportRes = await request(exportApp)
      .get(`/api/v1/requests/${id}/archive`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    expect(exportRes.status).toBe(200);
    const archiveBuf: Buffer = exportRes.body;
    const entries = await readTarGz(archiveBuf);

    // Source-blob → archive-entry mapping (mirrors packRunIntoTar's layout).
    const expectedArchiveEntries: Record<string, string> = {
      [`${id}/run.yaml`]: "<yaml>", // contents checked below
      [`${id}/iteration-1.tar.gz`]: `snapshots/${id}/iteration-1/workspace.tar.gz`,
      [`${id}/iteration-1.har`]: `snapshots/${id}/iteration-1/network.har`,
      [`${id}/run.har`]: `snapshots/${id}/run.har`,
      [`${id}/iteration-1.chat-export.json`]: `snapshots/${id}/iteration-1/chat-export.json`,
      [`${id}/run.chat-export.json`]: `snapshots/${id}/run.chat-export.json`,
      [`${id}/iteration-1.chat-result.json`]: `snapshots/${id}/iteration-1/chat-result.json`,
      [`${id}/iteration-1.tool-calls.jsonl`]: `snapshots/${id}/iteration-1/tool-calls.jsonl`,
      [`${id}/logs.jsonl`]: `logs/${id}/runs/${id}/run.jsonl`,
    };
    expect(Object.keys(entries).sort()).toEqual(Object.keys(expectedArchiveEntries).sort());
    for (const [entryName, srcKey] of Object.entries(expectedArchiveEntries)) {
      if (srcKey === "<yaml>") continue;
      expect(entries[entryName]).toEqual(blobStore.get(srcKey));
    }

    // 2. Re-import into a fresh blob store + Mongo. Importer ingests every
    // bundled artifact: HAR, chat-export, tool-calls, chat-result and
    // logs.jsonl. The dedicated round-trip test below pins the chat-result
    // and logs.jsonl paths specifically.
    blobStore.clear();
    const targetReqs = makeRequestCollection();
    const importApp = buildApp(targetReqs);
    const importRes = await request(importApp)
      .post(`/api/v1/runs/upload?projectId=${TEST_PROJECT_ID}`)
      .attach("archive", archiveBuf, "archive.tar.gz");
    expect(importRes.status).toBe(201);

    // Each ingested artifact must land at the importer's canonical blob
    // name with byte-equal contents.
    const expectedReuploads: Record<string, Buffer> = {
      [`snapshots/${id}/iteration-1/workspace.tar.gz`]: innerIterTar,
      [`snapshots/${id}/iteration-1/capture.har`]: blobs[`snapshots/${id}/iteration-1/network.har`],
      [`snapshots/${id}/capture.har`]: blobs[`snapshots/${id}/run.har`],
      [`snapshots/${id}/iteration-1/chat-export.json`]:
        blobs[`snapshots/${id}/iteration-1/chat-export.json`],
      [`snapshots/${id}/chat-export.json`]: blobs[`snapshots/${id}/run.chat-export.json`],
      [`snapshots/${id}/iteration-1/tool-calls.jsonl`]:
        blobs[`snapshots/${id}/iteration-1/tool-calls.jsonl`],
      [`snapshots/${id}/iteration-1/chat-result.json`]:
        blobs[`snapshots/${id}/iteration-1/chat-result.json`],
      [`logs/${id}/runs/${id}/run.jsonl`]: blobs[`logs/${id}/runs/${id}/run.jsonl`],
    };
    for (const [k, v] of Object.entries(expectedReuploads)) {
      expect(blobStore.get(k), `expected reupload at ${k}`).toEqual(v);
    }

    // The re-inserted run document points at the new canonical URLs.
    const reinserted = targetReqs.docs.get(id);
    expect(reinserted.run.harUrl).toMatch(new RegExp(`/snapshots/${id}/capture\\.har$`));
    expect(reinserted.run.rawChatUrl).toMatch(new RegExp(`/snapshots/${id}/chat-export\\.json$`));
    expect(reinserted.run.logsUrl).toMatch(new RegExp(`/logs/${id}/runs/${id}/run\\.jsonl$`));
    expect(reinserted.run.turns[0].harUrl).toMatch(
      new RegExp(`/snapshots/${id}/iteration-1/capture\\.har$`),
    );
    expect(reinserted.run.turns[0].rawChatUrl).toMatch(
      new RegExp(`/snapshots/${id}/iteration-1/chat-export\\.json$`),
    );
    expect(reinserted.run.turns[0].toolCallsUrl).toMatch(
      new RegExp(`/snapshots/${id}/iteration-1/tool-calls\\.jsonl$`),
    );
    expect(reinserted.run.turns[0].chatResultUrl).toMatch(
      new RegExp(`/snapshots/${id}/iteration-1/chat-result\\.json$`),
    );
  });

  it("round-trips per-iteration chat-result and run-level logs.jsonl", async () => {
    // Pinned-down round-trip for the two artifacts that historically were
    // packed into the archive but dropped on import. They now ride through
    // both directions; this test guards against regressing back to the
    // asymmetric behaviour.
    const id = "asym-1";
    const fixture: any = makeFixtureRun(id);
    fixture.run.logsUrl = blobUrl("logs", `${id}/runs/${id}/run.jsonl`);
    fixture.run.turns[0].chatResultUrl = blobUrl("snapshots", `${id}/iteration-1/chat-result.json`);

    const innerIterTar = await buildTarGz({ "x.txt": "x" });
    const chatResultBytes = Buffer.from('{"r":1}');
    const logsBytes = Buffer.from('{"level":"info","message":"hi"}\n');
    blobStore.set(`snapshots/${id}/iteration-1/workspace.tar.gz`, innerIterTar);
    blobStore.set(`snapshots/${id}/iteration-1/chat-result.json`, chatResultBytes);
    blobStore.set(`logs/${id}/runs/${id}/run.jsonl`, logsBytes);

    const sourceReqs = makeRequestCollection();
    sourceReqs.docs.set(id, fixture);

    const exportApp = buildApp(sourceReqs);
    const exportRes = await request(exportApp)
      .get(`/api/v1/requests/${id}/archive`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(exportRes.status).toBe(200);
    const archive = await readTarGz(exportRes.body);
    expect(archive[`${id}/iteration-1.chat-result.json`]).toEqual(chatResultBytes);
    expect(archive[`${id}/logs.jsonl`]).toEqual(logsBytes);

    blobStore.clear();
    const targetReqs = makeRequestCollection();
    const importApp = buildApp(targetReqs);
    const importRes = await request(importApp)
      .post(`/api/v1/runs/upload?projectId=${TEST_PROJECT_ID}`)
      .attach("archive", exportRes.body, "archive.tar.gz");
    expect(importRes.status).toBe(201);

    // chat-result lands at the canonical per-iteration blob and the turn
    // points at the new URL.
    const reinserted = targetReqs.docs.get(id);
    expect(blobStore.get(`snapshots/${id}/iteration-1/chat-result.json`)).toEqual(chatResultBytes);
    expect(reinserted.run.turns[0].chatResultUrl).toMatch(
      new RegExp(`/snapshots/${id}/iteration-1/chat-result\\.json$`),
    );

    // logs.jsonl is re-uploaded under the canonical per-attempt logs path
    // and run.logsUrl points at it.
    expect(blobStore.get(`logs/${id}/runs/${id}/run.jsonl`)).toEqual(logsBytes);
    expect(reinserted.run.logsUrl).toMatch(
      new RegExp(`/logs/${id}/runs/${id}/run\\.jsonl$`),
    );
  });

  it("preserves all top-level + run-level optional fields and the per-attempt run._id", async () => {
    // Symmetric round-trip guard. Builds a fixture that exercises every
    // optional field RequestResponseSchema + RunStateSchema know about,
    // plus every artifact type the exporter knows how to pack. Then:
    //
    //   1. export → import into a fresh target
    //   2. deep-equal the round-tripped Mongo doc against the source,
    //      excluding ONLY the fields whose values must legitimately
    //      change on import (per-environment blob URLs).
    //   3. snapshot the source blob set, and assert every byte made it
    //      back to a target blob with identical bytes (catches the case
    //      where the exporter starts packing a new artifact type that
    //      the importer drops on the floor).
    //
    // Adding a new optional field to the schema, or a new artifact type
    // to packRunIntoTar, will fail this test unless either:
    //   a) the importer round-trips it (preferred), or
    //   b) the field is added to FIELDS_THAT_MAY_DIVERGE below with a
    //      one-line justification, OR a new entry is added to
    //      `expectedTarEntries` if a new artifact type is introduced.
    const requestId = "rich-1";
    const runId = "run-attempt-rich-1"; // ← deliberately ≠ requestId
    const fixture: any = {
      _id: requestId,
      projectId: TEST_PROJECT_ID,
      scenario: { task: "do a thing", criteria: ["c1", "c2"] },
      workerType: "coder-acp-copilot",
      model: "claude-haiku-4.5",
      agentVersion: "copilot-dev",
      // Canonical UUIDv5 for the task text — must equal the value the
      // importer derives via taskPromptStore.findOrCreate(scenario.task)
      // for the symmetric-round-trip guard below to hold.
      taskPromptId: computeTaskPromptId("do a thing"),
      mcpServers: ["github", "filesystem"],
      skillRevisions: ["org/skill@rev1"],
      extensions: ["ms-python.python"],
      profileId: "profile-rich",
      profileVersionId: "profile-rich-v1",
      createdAt: new Date("2026-05-11T23:03:37.140Z"),
      updatedAt: new Date("2026-05-11T23:04:47.446Z"),
      maxIterations: 1,
      priority: 0,
      submissionId: "sub-rich-1",
      run: {
        _id: runId,
        attemptNumber: 2, // ← not 1; previous code hard-coded 1
        status: "done",
        outcome: "succeeded",
        result: "everything worked",
        // Source URLs use the importer's canonical paths so the byte-
        // equal blob check below has a stable baseline.
        logsUrl: blobUrl("logs", `${requestId}/runs/${runId}/run.jsonl`),
        harUrl: blobUrl("snapshots", `${requestId}/capture.har`),
        rawChatUrl: blobUrl("snapshots", `${requestId}/chat-export.json`),
        updatedAt: new Date("2026-05-11T23:04:47.446Z"),
        startedAt: new Date("2026-05-11T23:04:37.172Z"),
        finishedAt: new Date("2026-05-11T23:04:47.446Z"),
        durationMs: 10274, // finishedAt − startedAt; computed on write at import time
        workerVersion: "copilot-unknown-unknown-unknown",
        aiCallCount: 2,
        os: { platform: "linux", release: "6.6.114.1", arch: "x64" },
        tokenUsage: { promptTokens: 16, completionTokens: 397, totalTokens: 413 },
        turns: [
          {
            iteration: 1,
            timestamp: new Date("2026-05-11T23:04:47.430Z"),
            snapshotUrl: blobUrl("snapshots", `${requestId}/iteration-1/workspace.tar.gz`),
            harUrl: blobUrl("snapshots", `${requestId}/iteration-1/capture.har`),
            rawChatUrl: blobUrl("snapshots", `${requestId}/iteration-1/chat-export.json`),
            chatResultUrl: blobUrl("snapshots", `${requestId}/iteration-1/chat-result.json`),
            toolCallsUrl: blobUrl("snapshots", `${requestId}/iteration-1/tool-calls.jsonl`),
            judgeFeedback: "ok",
            passed: true,
            startedAt: new Date("2026-05-11T23:04:37.226Z"),
            durationMs: 10204,
            tokenUsage: { promptTokens: 16, completionTokens: 397, totalTokens: 413 },
            aiCallCount: 2,
            toolCallCount: 1,
          },
        ],
      },
    };

    // Seed source blobs. One of every artifact type the exporter packs.
    // If a new entry name appears in packRunIntoTar (apps/api/src/archive-har.ts)
    // without a corresponding entry here, the `expectedTarEntries` assertion
    // below will fail and force the author to wire it through the importer.
    const innerIterTar = await buildTarGz({ "x.txt": "iteration-1 contents" });
    const sourceBlobs: Record<string, Buffer> = {
      [`snapshots/${requestId}/iteration-1/workspace.tar.gz`]: innerIterTar,
      [`snapshots/${requestId}/iteration-1/capture.har`]: Buffer.from('{"log":{"iter":1}}'),
      [`snapshots/${requestId}/capture.har`]: Buffer.from('{"log":{"top":true}}'),
      [`snapshots/${requestId}/iteration-1/chat-export.json`]: Buffer.from('{"chat":"iter"}'),
      [`snapshots/${requestId}/chat-export.json`]: Buffer.from('{"chat":"top"}'),
      [`snapshots/${requestId}/iteration-1/chat-result.json`]: Buffer.from('{"result":"iter"}'),
      [`snapshots/${requestId}/iteration-1/tool-calls.jsonl`]:
        Buffer.from('{"tool":"a"}\n{"tool":"b"}\n'),
      [`logs/${requestId}/runs/${runId}/run.jsonl`]:
        Buffer.from('{"level":"info","message":"rich"}\n'),
    };
    for (const [k, v] of Object.entries(sourceBlobs)) blobStore.set(k, v);

    const sourceReqs = makeRequestCollection();
    sourceReqs.docs.set(requestId, fixture);

    // ── Export ────────────────────────────────────────────────────────
    const exportApp = buildApp(sourceReqs);
    const exportRes = await request(exportApp)
      .get(`/api/v1/requests/${requestId}/archive`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(exportRes.status).toBe(200);
    const archiveBuf: Buffer = exportRes.body;

    // Pin the exact set of tar entries the export produces. If anyone
    // adds a new entry to packRunIntoTar without updating this test or
    // the importer's canonicalBlobTarget(), this fails loudly.
    const tarEntries = await readTarGz(archiveBuf);
    const expectedTarEntries = [
      `${requestId}/run.yaml`,
      `${requestId}/iteration-1.tar.gz`,
      `${requestId}/iteration-1.har`,
      `${requestId}/run.har`,
      `${requestId}/iteration-1.chat-export.json`,
      `${requestId}/run.chat-export.json`,
      `${requestId}/iteration-1.chat-result.json`,
      `${requestId}/iteration-1.tool-calls.jsonl`,
      `${requestId}/logs.jsonl`,
    ];
    expect(Object.keys(tarEntries).sort()).toEqual(expectedTarEntries.sort());

    // ── Re-import into a fresh target ─────────────────────────────────
    blobStore.clear();
    const targetReqs = makeRequestCollection();
    const importApp = buildApp(targetReqs);
    const importRes = await request(importApp)
      .post(`/api/v1/runs/upload?projectId=${TEST_PROJECT_ID}`)
      .attach("archive", archiveBuf, "archive.tar.gz");
    expect(importRes.status).toBe(201);

    // ── Assertion 1: deep-equal Mongo doc with explicit exclusions ───
    //
    // The fields below MUST diverge between source and target — list
    // each one with its justification. Any other divergence is a bug.
    const FIELDS_THAT_MAY_DIVERGE = new Set<string>([
      // Per-environment blob URLs. Source URLs point at the source
      // storage account; the importer rewrites them to point at the
      // target's storage account but at the same canonical paths.
      // Path equivalence is asserted separately in Assertion 3.
      "run.logsUrl",
      "run.harUrl",
      "run.rawChatUrl",
      // Same reasoning, per-turn.
      "run.turns.*.snapshotUrl",
      "run.turns.*.harUrl",
      "run.turns.*.rawChatUrl",
      "run.turns.*.chatResultUrl",
      "run.turns.*.toolCallsUrl",
    ]);
    function stripDivergent(obj: unknown, prefix = ""): unknown {
      if (Array.isArray(obj)) {
        return obj.map((v, _i) => stripDivergent(v, `${prefix}.*`.replace(/^\.\*$/, "*")));
      }
      if (obj && typeof obj === "object" && !(obj instanceof Date)) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
          const path = prefix ? `${prefix}.${k}` : k;
          if (FIELDS_THAT_MAY_DIVERGE.has(path)) continue;
          out[k] = stripDivergent(v, path);
        }
        return out;
      }
      return obj;
    }
    const target = targetReqs.docs.get(requestId);
    expect(stripDivergent(target)).toEqual(stripDivergent(fixture));

    // ── Assertion 2: per-attempt run._id is preserved ────────────────
    // Singled out because the previous code clobbered it with requestId
    // and stripDivergent would have caught it as a value mismatch but
    // the message would have been buried in a 200-line diff. Pin it.
    expect(target.run._id).toBe(runId);
    expect(target.run._id).not.toBe(requestId);

    // ── Assertion 3: every source blob round-trips byte-equal ────────
    //
    // Compare by content. For each source blob, the same bytes must
    // appear in the target blob store. We compare by SHA so the test
    // doesn't need to know the source→target path mapping (the importer
    // canonicalises some paths) — if the exporter adds a new artifact
    // that doesn't reach the importer, the SHA multisets diverge.
    const { createHash } = await import("crypto");
    const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    const sourceShas = [...Object.values(sourceBlobs)].map(sha).sort();
    const targetShas = [...blobStore.values()].map(sha).sort();
    expect(targetShas).toEqual(sourceShas);

    // ── Assertion 4: per-environment URL paths land where canonical ──
    // Pinned explicitly because Assertion 1 strips them.
    expect(target.run.logsUrl).toMatch(
      new RegExp(`/logs/${requestId}/runs/${runId}/run\\.jsonl$`),
    );
    expect(target.run.harUrl).toMatch(
      new RegExp(`/snapshots/${requestId}/capture\\.har$`),
    );
    expect(target.run.rawChatUrl).toMatch(
      new RegExp(`/snapshots/${requestId}/chat-export\\.json$`),
    );
    expect(target.run.turns[0].snapshotUrl).toMatch(
      new RegExp(`/snapshots/${requestId}/iteration-1/workspace\\.tar\\.gz$`),
    );
    expect(target.run.turns[0].harUrl).toMatch(
      new RegExp(`/snapshots/${requestId}/iteration-1/capture\\.har$`),
    );
    expect(target.run.turns[0].rawChatUrl).toMatch(
      new RegExp(`/snapshots/${requestId}/iteration-1/chat-export\\.json$`),
    );
    expect(target.run.turns[0].chatResultUrl).toMatch(
      new RegExp(`/snapshots/${requestId}/iteration-1/chat-result\\.json$`),
    );
    expect(target.run.turns[0].toolCallsUrl).toMatch(
      new RegExp(`/snapshots/${requestId}/iteration-1/tool-calls\\.jsonl$`),
    );
  });
});

describe("run import — task-prompt entity creation (#832)", () => {
  // Task-prompt entities back features, report triggers, group-by-task,
  // the runs-list task filter and the criteria/MDP analysis. The submission
  // flow (POST /api/v1/requests) materializes them via
  // taskPromptStore.findOrCreate(scenario.task). Imported runs used to skip
  // this step entirely \u2014 `taskPromptId` was preserved from `run.yaml` but
  // no row was ever created, leaving a dangling reference.

  function makeMinimalUploadYaml(id: string, task: string, taskPromptId?: string) {
    const lines = [
      `_id: ${id}`,
      `projectId: ${TEST_PROJECT_ID}`,
      `scenario:`,
      `  task: ${JSON.stringify(task)}`,
      `  criteria: []`,
      `workerType: coder-acp-copilot`,
      `createdAt: 2026-01-01T00:00:00Z`,
      ...(taskPromptId ? [`taskPromptId: ${taskPromptId}`] : []),
      `run:`,
      `  _id: ${id}`,
      `  attemptNumber: 1`,
      `  status: done`,
    ];
    return lines.join("\n") + "\n";
  }

  it("creates a task-prompt entity for the imported run's scenario.task", async () => {
    const task = "Build an Express API";
    const id = "tp-create-1";
    const expectedId = computeTaskPromptId(task);

    const taskPromptStore = makeTaskPromptStore();
    const reqCollection = makeRequestCollection();
    const app = buildApp(reqCollection, taskPromptStore);

    const archive = await buildTarGz({
      [`${id}/run.yaml`]: makeMinimalUploadYaml(id, task),
    });
    const res = await request(app)
      .post(`/api/v1/runs/upload?projectId=${TEST_PROJECT_ID}`)
      .attach("archive", archive, "archive.tar.gz");

    expect(res.status).toBe(201);
    // findOrCreate was invoked with the run's scenario.task.
    expect(taskPromptStore.findOrCreate).toHaveBeenCalledWith(TEST_PROJECT_ID, task);
    // A row now exists in the task-prompts collection at the canonical id.
    expect(taskPromptStore.docs.get(expectedId)).toMatchObject({ _id: expectedId, text: task });
    // The inserted request points at it.
    const inserted = reqCollection.docs.get(id);
    expect(inserted.taskPromptId).toBe(expectedId);
  });

  it("reuses an existing task prompt and does not create a duplicate", async () => {
    const task = "Already known task";
    const expectedId = computeTaskPromptId(task);

    const taskPromptStore = makeTaskPromptStore();
    // Pre-seed the store as if a previous submission/import had created it.
    const original = { _id: expectedId, text: task, createdAt: new Date("2025-01-01T00:00:00Z") };
    taskPromptStore.docs.set(expectedId, original);

    const reqCollection = makeRequestCollection();
    const app = buildApp(reqCollection, taskPromptStore);

    const archive = await buildTarGz({
      [`tp-reuse-1/run.yaml`]: makeMinimalUploadYaml("tp-reuse-1", task),
    });
    const res = await request(app)
      .post(`/api/v1/runs/upload?projectId=${TEST_PROJECT_ID}`)
      .attach("archive", archive, "archive.tar.gz");

    expect(res.status).toBe(201);
    expect(taskPromptStore.docs.size).toBe(1);
    // The existing document was returned (createdAt unchanged).
    expect(taskPromptStore.docs.get(expectedId)).toBe(original);
    expect(reqCollection.docs.get("tp-reuse-1").taskPromptId).toBe(expectedId);
  });

  it("repairs a stale taskPromptId in run.yaml with the canonical UUIDv5", async () => {
    // Older exports may carry a taskPromptId that does not match
    // computeTaskPromptId(scenario.task) (e.g. taken from a renamed task or
    // a pre-content-addressed era). The importer must rewrite it so the
    // row it just created is the one the run links to.
    const task = "do a thing";
    const id = "tp-repair-1";
    const expectedId = computeTaskPromptId(task);
    const staleId = "00000000-0000-0000-0000-000000000bad";
    expect(staleId).not.toBe(expectedId);

    const taskPromptStore = makeTaskPromptStore();
    const reqCollection = makeRequestCollection();
    const app = buildApp(reqCollection, taskPromptStore);

    const archive = await buildTarGz({
      [`${id}/run.yaml`]: makeMinimalUploadYaml(id, task, staleId),
    });
    const res = await request(app)
      .post(`/api/v1/runs/upload?projectId=${TEST_PROJECT_ID}`)
      .attach("archive", archive, "archive.tar.gz");

    expect(res.status).toBe(201);
    expect(reqCollection.docs.get(id).taskPromptId).toBe(expectedId);
  });

  it("batch import dedupes shared task texts to a single task-prompt entity", async () => {
    const task = "shared task across runs";
    const expectedId = computeTaskPromptId(task);
    const taskPromptStore = makeTaskPromptStore();
    const reqCollection = makeRequestCollection();
    const app = buildApp(reqCollection, taskPromptStore);

    const archive = await buildTarGz({
      [`bd-1/run.yaml`]: makeMinimalUploadYaml("bd-1", task),
      [`bd-2/run.yaml`]: makeMinimalUploadYaml("bd-2", task),
      [`bd-3/run.yaml`]: makeMinimalUploadYaml("bd-3", task),
    });
    const res = await request(app)
      .post(`/api/v1/runs/upload-batch?projectId=${TEST_PROJECT_ID}`)
      .attach("archive", archive, "batch.tar.gz");

    expect(res.status).toBe(201);
    expect(res.body.imported).toHaveLength(3);
    // findOrCreate is called once per run, but dedupes to a single row.
    expect(taskPromptStore.findOrCreate).toHaveBeenCalledTimes(3);
    expect(taskPromptStore.docs.size).toBe(1);
    expect(taskPromptStore.docs.has(expectedId)).toBe(true);
    for (const id of ["bd-1", "bd-2", "bd-3"]) {
      expect(reqCollection.docs.get(id).taskPromptId).toBe(expectedId);
    }
  });
});

describe("batch run import (POST /api/v1/runs/upload-batch)", () => {
  it("returns 400 when no file is uploaded", async () => {
    const app = buildApp(makeRequestCollection());
    const res = await request(app).post(`/api/v1/runs/upload-batch?projectId=${TEST_PROJECT_ID}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no archive file/i);
  });

  it("returns 400 when the batch archive contains no run subdirectories", async () => {
    const app = buildApp(makeRequestCollection());
    // Tar with only a stray top-level file — no <runId>/ subtree.
    const archive = await buildTarGz({ "stray.txt": "no run here" });
    const res = await request(app)
      .post(`/api/v1/runs/upload-batch?projectId=${TEST_PROJECT_ID}`)
      .attach("archive", archive, "batch.tar.gz");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must live under a <runId>\/ subdirectory/i);
  });

  it("round-trips a batch archive containing two runs", async () => {
    // Round-trip via the existing batch-export endpoint: gives us a real
    // batch archive in the exact shape the importer must accept.
    const id1 = "batch-1";
    const id2 = "batch-2";
    const fixture1 = makeFixtureRun(id1);
    const fixture2 = makeFixtureRun(id2);

    const sourceReqs = makeRequestCollection();
    sourceReqs.docs.set(id1, fixture1);
    sourceReqs.docs.set(id2, fixture2);
    blobStore.set(
      `snapshots/${id1}/iteration-1/workspace.tar.gz`,
      await buildTarGz({ "a.txt": "run-1 contents" }),
    );
    blobStore.set(
      `snapshots/${id2}/iteration-1/workspace.tar.gz`,
      await buildTarGz({ "b.txt": "run-2 contents" }),
    );

    const exportApp = buildApp(sourceReqs);
    const exportRes = await request(exportApp)
      .post("/api/v1/requests/archive")
      .send({ ids: [id1, id2] })
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(exportRes.status).toBe(200);

    // Verify: archive contains both run subtrees.
    const entries = await readTarGz(exportRes.body);
    expect(Object.keys(entries)).toEqual(
      expect.arrayContaining([
        `${id1}/run.yaml`,
        `${id1}/iteration-1.tar.gz`,
        `${id2}/run.yaml`,
        `${id2}/iteration-1.tar.gz`,
      ]),
    );

    blobStore.clear();
    const targetReqs = makeRequestCollection();
    const importApp = buildApp(targetReqs);
    const importRes = await request(importApp)
      .post(`/api/v1/runs/upload-batch?projectId=${TEST_PROJECT_ID}`)
      .attach("archive", exportRes.body, "batch.tar.gz");

    expect(importRes.status).toBe(201);
    expect(importRes.body.failed).toEqual([]);
    expect(importRes.body.imported).toHaveLength(2);
    const importedIds = (importRes.body.imported as Array<{ id: string }>).map(r => r.id).sort();
    expect(importedIds).toEqual([id1, id2]);

    // Both docs landed in target Mongo and both iteration blobs were
    // re-uploaded.
    expect(targetReqs.docs.has(id1)).toBe(true);
    expect(targetReqs.docs.has(id2)).toBe(true);
    expect(blobStore.has(`snapshots/${id1}/iteration-1/workspace.tar.gz`)).toBe(true);
    expect(blobStore.has(`snapshots/${id2}/iteration-1/workspace.tar.gz`)).toBe(true);
  });

  it("returns 207 multi-status when some runs succeed and others conflict", async () => {
    const id1 = "batch-ok";
    const id2 = "batch-conflict";
    const fixture1 = makeFixtureRun(id1);
    const fixture2 = makeFixtureRun(id2);

    const sourceReqs = makeRequestCollection();
    sourceReqs.docs.set(id1, fixture1);
    sourceReqs.docs.set(id2, fixture2);
    blobStore.set(`snapshots/${id1}/iteration-1/workspace.tar.gz`, await buildTarGz({ "x": "1" }));
    blobStore.set(`snapshots/${id2}/iteration-1/workspace.tar.gz`, await buildTarGz({ "x": "2" }));

    const exportApp = buildApp(sourceReqs);
    const exportRes = await request(exportApp)
      .post("/api/v1/requests/archive")
      .send({ ids: [id1, id2] })
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(exportRes.status).toBe(200);

    blobStore.clear();
    const targetReqs = makeRequestCollection();
    // Pre-seed the conflict run on the target so its import returns 409.
    targetReqs.docs.set(id2, makeFixtureRun(id2));

    const importApp = buildApp(targetReqs);
    const importRes = await request(importApp)
      .post(`/api/v1/runs/upload-batch?projectId=${TEST_PROJECT_ID}`)
      .attach("archive", exportRes.body, "batch.tar.gz");

    expect(importRes.status).toBe(207);
    expect(importRes.body.imported).toHaveLength(1);
    expect(importRes.body.imported[0].id).toBe(id1);
    expect(importRes.body.failed).toHaveLength(1);
    expect(importRes.body.failed[0].id).toBe(id2);
    expect(importRes.body.failed[0].statusCode).toBe(409);
    expect(importRes.body.failed[0].error).toMatch(/already exists/i);
  });
});
