// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, vi } from "vitest";

vi.mock("db-migrations/check-migrations", () => ({
  checkMigrations: vi.fn().mockResolvedValue(undefined),
}));

const { generateOpenAPIDocument } = await import("./openapi/registry.js");
await import("./index.js");

/**
 * Worker/judge read routes that are expected to be called with a run token.
 * Changing this list changes the documented run-token surface; keep it in sync
 * with the worker clients and the authorization layer.
 */
const EXPECTED_RUN_TOKEN_ROUTES = [
  "GET /api/v1/codebase-revisions/{id}",
  "GET /api/v1/codebase-revisions/{id}/archive",
  "GET /api/v1/criteria",
  "GET /api/v1/criteria/{id}",
  "GET /api/v1/extensions/{id}",
  "GET /api/v1/mcp/servers/{id}",
  "GET /api/v1/resources/revisions/{id}",
  "GET /api/v1/resources/{id}",
  "GET /api/v1/resources/{id}/revisions/latest",
  "GET /api/v1/resources/{id}/revisions/{revisionNumber}",
  "GET /api/v1/skill-revisions/by-ref/{ref}",
  "GET /api/v1/skill-revisions/by-ref/{ref}/archive",
  "GET /api/v1/task-prompts/{id}",
  "GET /api/v1/task-prompts/{id}/content",
].sort();

describe("run-token route inventory", () => {
  it("flags exactly the worker read routes", () => {
    const doc = generateOpenAPIDocument();
    const flagged: string[] = [];
    for (const [path, item] of Object.entries(doc.paths ?? {})) {
      for (const [method, op] of Object.entries(item as Record<string, unknown>)) {
        if ((op as Record<string, unknown> | undefined)?.["x-scope-run-token"] === true) {
          flagged.push(`${method.toUpperCase()} ${path.replace("(*)", "")}`);
        }
      }
    }
    expect(flagged.sort()).toEqual(EXPECTED_RUN_TOKEN_ROUTES);
  });
});
