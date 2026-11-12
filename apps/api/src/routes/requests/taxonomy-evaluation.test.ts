// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import supertest from "supertest";
import { app, _injectTestDependencies } from "../../index.js";
import { useTestServer } from "../../test-server.js";
import { createAllMockDependencies } from "../../test-helpers.js";

vi.mock("db-migrations/check-migrations", () => ({
  checkMigrations: vi
    .fn()
    .mockResolvedValue({ ready: true, applied: ["001"], pending: [] }),
}));
vi.mock("../../llm.js", () => ({
  isLlmAvailable: vi.fn().mockReturnValue(false),
}));
vi.mock("../../prompt-feature-llm.js", () => ({
  isLlmAvailable: vi.fn().mockReturnValue(false),
}));
vi.mock("../../task-prompt-llm.js", () => ({
  isTaskPromptLlmAvailable: vi.fn().mockReturnValue(false),
}));

const validResult = {
  run: {
    id: "run-1",
    scenario: { id: "scenario-1", label: "Scenario" },
    profile: { id: "profile-1", label: "Profile" },
  },
  results: [
    {
      schema_version: "scope/taxonomy-evaluation/v1",
      status: "succeeded",
      taxonomy: {
        id: "ax-taxonomy",
        version: "1.0.0",
        digest: "a".repeat(64),
      },
      element: { id: "element-1", label: "Element" },
      implementation: {
        type: "deterministic",
        handler: "element-1",
        attempts: [{ attempt: 1, kind: "initial", outcome: "succeeded" }],
      },
      input: {
        normalization: "scope/taxonome-normalized-atif/v1",
        sha256: "b".repeat(64),
      },
      result: { state: "completed", observed: false },
    },
  ],
};

function artifactFor(value: unknown) {
  const body = Buffer.from(JSON.stringify(value));
  return {
    compressed: gzipSync(body),
    reference: {
      url: "https://storage.example/result.json.gz",
      schemaVersion: "2",
      contentSha256: createHash("sha256").update(body).digest("hex"),
      sizeBytes: body.byteLength,
    },
  };
}

describe("taxonomy evaluation JSON endpoint", () => {
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
    (mocks.featureFlagCollection.findOne as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ key: "taxonome", enabled: true });
  });

  function mockCurrentRun(reference?: ReturnType<typeof artifactFor>["reference"]) {
    (mocks.collection.findOne as ReturnType<typeof vi.fn>).mockResolvedValue({
      _id: "request-1",
      run: {
        _id: "run-1",
        status: "done",
        taxonomyEvaluation: reference,
      },
    });
  }

  it("returns a validated exact-run result", async () => {
    const artifact = artifactFor(validResult);
    mockCurrentRun(artifact.reference);
    (mocks.blobStorage.downloadBuffer as ReturnType<typeof vi.fn>) = vi
      .fn()
      .mockResolvedValue(artifact.compressed);

    const response = await supertest(testServer()).get(
      "/api/v1/requests/request-1/runs/run-1/taxonomy-evaluation/json",
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual(validResult);
  });

  it("fails closed when Taxonome is disabled", async () => {
    (mocks.featureFlagCollection.findOne as ReturnType<typeof vi.fn>)
      .mockResolvedValue(null);

    const response = await supertest(testServer()).get(
      "/api/v1/requests/request-1/runs/run-1/taxonomy-evaluation/json",
    );

    expect(response.status).toBe(404);
  });

  it("rejects a run outside the exact request", async () => {
    (mocks.collection.findOne as ReturnType<typeof vi.fn>).mockResolvedValue({
      _id: "request-1",
      run: { _id: "another-run", status: "done" },
    });
    (mocks.runsCollection.findOne as ReturnType<typeof vi.fn>)
      .mockResolvedValue(null);

    const response = await supertest(testServer()).get(
      "/api/v1/requests/request-1/runs/run-1/taxonomy-evaluation/json",
    );

    expect(response.status).toBe(404);
  });

  it("rejects missing and oversized result references before Blob reads", async () => {
    mockCurrentRun();
    const missing = await supertest(testServer()).get(
      "/api/v1/requests/request-1/runs/run-1/taxonomy-evaluation/json",
    );
    expect(missing.status).toBe(404);

    const artifact = artifactFor(validResult);
    mockCurrentRun({
      ...artifact.reference,
      sizeBytes: 10 * 1024 * 1024 + 1,
    });
    const oversized = await supertest(testServer()).get(
      "/api/v1/requests/request-1/runs/run-1/taxonomy-evaluation/json",
    );
    expect(oversized.status).toBe(413);
  });

  it("reports unavailable and invalid compressed artifacts distinctly", async () => {
    const artifact = artifactFor(validResult);
    mockCurrentRun(artifact.reference);
    (mocks.blobStorage.downloadBuffer as ReturnType<typeof vi.fn>) = vi
      .fn()
      .mockRejectedValue(new Error("missing"));
    const unavailable = await supertest(testServer()).get(
      "/api/v1/requests/request-1/runs/run-1/taxonomy-evaluation/json",
    );
    expect(unavailable.status).toBe(502);

    (mocks.blobStorage.downloadBuffer as ReturnType<typeof vi.fn>) = vi
      .fn()
      .mockResolvedValue(Buffer.from("not gzip"));
    const invalid = await supertest(testServer()).get(
      "/api/v1/requests/request-1/runs/run-1/taxonomy-evaluation/json",
    );
    expect(invalid.status).toBe(409);
  });

  it("rejects size and digest mismatches", async () => {
    const artifact = artifactFor(validResult);
    mockCurrentRun({ ...artifact.reference, sizeBytes: artifact.reference.sizeBytes + 1 });
    (mocks.blobStorage.downloadBuffer as ReturnType<typeof vi.fn>) = vi
      .fn()
      .mockResolvedValue(artifact.compressed);
    const sizeMismatch = await supertest(testServer()).get(
      "/api/v1/requests/request-1/runs/run-1/taxonomy-evaluation/json",
    );
    expect(sizeMismatch.status).toBe(409);

    mockCurrentRun({ ...artifact.reference, contentSha256: "0".repeat(64) });
    const digestMismatch = await supertest(testServer()).get(
      "/api/v1/requests/request-1/runs/run-1/taxonomy-evaluation/json",
    );
    expect(digestMismatch.status).toBe(409);
  });

  it("rejects malformed JSON and schema-invalid documents", async () => {
    for (const value of ["not json", { run: {}, results: [] }]) {
      const body =
        typeof value === "string"
          ? Buffer.from(value)
          : Buffer.from(JSON.stringify(value));
      mockCurrentRun({
        url: "https://storage.example/result.json.gz",
        schemaVersion: "2",
        contentSha256: createHash("sha256").update(body).digest("hex"),
        sizeBytes: body.byteLength,
      });
      (mocks.blobStorage.downloadBuffer as ReturnType<typeof vi.fn>) = vi
        .fn()
        .mockResolvedValue(gzipSync(body));

      const response = await supertest(testServer()).get(
        "/api/v1/requests/request-1/runs/run-1/taxonomy-evaluation/json",
      );
      expect(response.status).toBe(409);
    }
  });
});
