// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Stub checkMigrations before index.ts can import it
vi.mock("db-migrations/check-migrations", () => ({
  checkMigrations: vi.fn().mockResolvedValue({
    ready: true,
    applied: ["001", "002"],
    pending: [],
  }),
}));

vi.mock("./llm.js", () => ({
  isLlmAvailable: vi.fn().mockReturnValue(false),
  generateCriteriaPrompt: vi.fn(),
}));
vi.mock("./prompt-feature-llm.js", () => ({
  isLlmAvailable: vi.fn().mockReturnValue(false),
  generatePromptFeaturePrompt: vi.fn(),
  extractPromptFeatures: vi.fn(),
}));
vi.mock("./task-prompt-llm.js", () => ({
  isTaskPromptLlmAvailable: vi.fn().mockReturnValue(false),
  generateTaskPrompt: vi.fn(),
}));

describe("OpenAPI spec snapshot", () => {
  it("matches the committed snapshot", async () => {
    // Import index.ts to trigger all route registrations (register*Routes calls)
    await import("./index.js");
    const { generateOpenAPIDocument } = await import("./openapi/index.js");
    const doc = generateOpenAPIDocument();

    expect(doc.components?.securitySchemes?.bearerAuth).toMatchObject({
      type: "http",
      scheme: "bearer",
      bearerFormat: "JWT",
    });
    expect(doc.paths?.["/api/v1/users/me"]?.get?.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.paths?.["/api/v1/users/me"]?.post?.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.paths?.["/api/v1/users/me"]?.post?.responses).toHaveProperty("200");
    expect(doc).not.toHaveProperty("security");
    const securedOperations: string[] = [];
    for (const [path, item] of Object.entries(doc.paths ?? {})) {
      for (const method of ["get", "post", "put", "patch", "delete", "head", "options", "trace"] as const) {
        if (item?.[method]?.security !== undefined) {
          securedOperations.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    expect(securedOperations).toEqual(["GET /api/v1/users/me", "POST /api/v1/users/me"]);

    // Snapshot the full spec — catches dropped routes, changed schemas, etc.
    expect(doc).toMatchSnapshot();

    const websiteSpecPath = fileURLToPath(
      new URL("../../../website/src/openapi/scope-openapi.json", import.meta.url),
    );
    const websiteSpec = await readFile(websiteSpecPath, "utf8");
    expect(websiteSpec).toBe(JSON.stringify(doc));
  }, 30_000); // index.ts pulls in the entire route surface; 5s default is too tight under full-suite load.
});
