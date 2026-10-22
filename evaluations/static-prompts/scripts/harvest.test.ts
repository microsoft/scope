// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  ScopeApiClient,
  curateContributionCases,
  curateContributionDecisionCases,
  deterministicSample,
  redactText,
  redactValue,
  resolveProject,
  validateOpenApi,
  type OpenApiDocument,
  type DatasetCase,
} from "./harvest.js";

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../tests/fixtures/harvest-openapi.json",
);

async function openApiFixture(): Promise<OpenApiDocument> {
  return JSON.parse(await readFile(FIXTURE, "utf8")) as OpenApiDocument;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("validateOpenApi", () => {
  it("accepts the recorded minimal integration contract", async () => {
    const spec = await openApiFixture();
    expect(() => validateOpenApi(spec)).not.toThrow();
  });

  it("fails before harvesting when a required endpoint disappears", async () => {
    const spec = await openApiFixture();
    if (!spec.paths) throw new Error("fixture has no paths");
    delete spec.paths["/api/v1/requests"];
    expect(() => validateOpenApi(spec)).toThrow("OpenAPI does not define GET /api/v1/requests");
  });
});

describe("ScopeApiClient pagination", () => {
  it("follows offset pages and resolves blob-backed task content", async () => {
    const spec = await openApiFixture();
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/openapi.json") return jsonResponse(spec);
      if (parsed.pathname === "/api/v1/task-prompts" && parsed.searchParams.get("offset") === "0") {
        return jsonResponse({
          items: [
            { _id: "one", keyId: "one", text: "First prompt", projectId: "project" },
            { _id: "two", keyId: "two", contentBlobUrl: "https://storage.invalid/two", projectId: "project" },
          ],
          total: 3,
          limit: 2,
          offset: 0,
        });
      }
      if (parsed.pathname === "/api/v1/task-prompts" && parsed.searchParams.get("offset") === "2") {
        return jsonResponse({
          items: [{ _id: "three", keyId: "three", text: "Third prompt", projectId: "project" }],
          total: 3,
          limit: 2,
          offset: 2,
        });
      }
      if (parsed.pathname === "/api/v1/task-prompts/two/content") {
        return jsonResponse({ id: "two", text: "Resolved second prompt" });
      }
      return jsonResponse({ error: "not found" }, 404);
    });
    const client = new ScopeApiClient("https://scope.example", undefined, fetchMock);
    await client.initialize();
    const tasks = await client.taskPrompts("project", 2);
    expect(tasks.map((task) => task.text)).toEqual([
      "First prompt",
      "Resolved second prompt",
      "Third prompt",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("follows cursor pages without repeating the first page", async () => {
    const spec = await openApiFixture();
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/openapi.json") return jsonResponse(spec);
      if (!parsed.searchParams.has("after")) {
        return jsonResponse({
          data: [{ _id: "request-a", scenario: { task: "A", criteria: [] }, workerType: "worker", projectId: "project" }],
          limit: 1,
          estimatedTotal: 2,
          cursors: { next: "cursor-a", prev: null },
        });
      }
      expect(parsed.searchParams.get("after")).toBe("cursor-a");
      return jsonResponse({
        data: [{ _id: "request-b", scenario: { task: "B", criteria: [] }, workerType: "worker", projectId: "project" }],
        limit: 1,
        estimatedTotal: 2,
        cursors: { next: null, prev: "cursor-a" },
      });
    });
    const client = new ScopeApiClient("https://scope.example", undefined, fetchMock);
    await client.initialize();
    await expect(client.requests("project", 1)).resolves.toMatchObject([
      { _id: "request-a" },
      { _id: "request-b" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("requests tool-call evidence for the selected iteration", async () => {
    const spec = await openApiFixture();
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/openapi.json") return jsonResponse(spec);
      expect(parsed.pathname).toBe("/api/v1/requests/request/runs/run/tool-calls");
      expect(parsed.searchParams.get("iteration")).toBe("3");
      return new Response('{"name":"bash","arguments":{"command":"pnpm test"}}\n');
    });
    const client = new ScopeApiClient("https://scope.example", undefined, fetchMock);
    await client.initialize();
    await expect(client.toolCalls("request", "run", 3)).resolves.toHaveLength(1);
  });
});

describe("project resolution", () => {
  const baseOptions = {
    baseUrl: "https://scope.example",
    projectName: "Default Project",
    datasetVersion: "v1",
    seed: "seed",
    outputDir: "datasets",
  };

  it("resolves the Default Project by exact name", () => {
    expect(resolveProject([
      { id: "other", name: "Other" },
      { id: "default", name: "Default Project" },
    ], baseOptions)).toEqual({ id: "default", name: "Default Project" });
  });

  it("rejects ambiguous project names", () => {
    expect(() => resolveProject([
      { id: "one", name: "Default Project" },
      { id: "two", name: "Default Project" },
    ], baseOptions)).toThrow("Expected exactly one project");
  });
});

describe("deterministic curation and redaction", () => {
  it.each([
    ["contribution-insights", curateContributionCases],
    ["contribution-decision", curateContributionDecisionCases],
  ] as const)("reproduces the committed %s fixtures without integration or model calls", async (family, curate) => {
    const rows = (await readFile(new URL(`../datasets/v1/${family}.jsonl`, import.meta.url), "utf8"))
      .trim().split("\n").map((line): DatasetCase => JSON.parse(line));
    const provenance = rows[0].provenance;
    const regenerated = curate({
      projectId: provenance.projectId, harvestedAt: provenance.harvestedAt, seed: provenance.selectionSeed,
    }).sort((a, b) => a.id.localeCompare(b.id));
    expect(regenerated).toEqual(rows);
    if (family === "contribution-insights") {
      expect(rows.every((row) => !("contribution_decision" in row.expected))).toBe(true);
      expect(rows.every((row) => !row.evaluators.includes("contribution_decision"))).toBe(true);
    } else {
      expect(new Set(rows.map((row) => row.expected.action))).toContain("manual-review-required");
      expect(rows.every((row) => !("decision" in row.input) && !("recommendation" in row.input))).toBe(true);
    }
  });

  it("selects the same identities for the same seed", () => {
    const values = ["a", "b", "c", "d", "e"];
    expect(deterministicSample(values, 3, "seed", String)).toEqual(
      deterministicSample([...values].reverse(), 3, "seed", String),
    );
    expect(deterministicSample(values, 3, "seed", String)).not.toEqual(
      deterministicSample(values, 3, "different-seed", String),
    );
  });

  it("redacts secrets, user identifiers, and signed storage URLs recursively", () => {
    const redacted = redactValue({
      text: "Bearer secret-token email me@example.com from /Users/alice/project",
      snapshotUrl: "https://account.blob.core.windows.net/a?sas=secret",
      nested: {
        url: "https://account.blob.core.windows.net/a?sig=secret&se=tomorrow",
        apiKey: "super-secret",
      },
    });
    expect(redacted).toEqual({
      text: "Bearer [REDACTED_SECRET] email [REDACTED_EMAIL] from /Users/[REDACTED_USER]/project",
      nested: {
        url: "[REDACTED_STORAGE_URL]",
        apiKey: "[REDACTED_SECRET]",
      },
    });
    expect(redactText("https://example.com/docs?token=secret")).toBe("[REDACTED_STORAGE_URL]");
  });
});
