// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenAPIObject } from "openapi3-ts/oas31";
import { LEGACY_REQUEST_COMPOSITION_DEPRECATION_ID } from "shared";

vi.mock("db-migrations/check-migrations", () => ({
  checkMigrations: vi.fn().mockResolvedValue({
    ready: true,
    applied: [],
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

let document: OpenAPIObject;

beforeAll(async () => {
  await import("./index.js");
  const { generateOpenAPIDocument } = await import("./openapi/index.js");
  document = generateOpenAPIDocument();
});

describe("Experiment OpenAPI contract", () => {
  it("exports the shared legacy composition deprecation identifier", () => {
    expect(LEGACY_REQUEST_COMPOSITION_DEPRECATION_ID).toBe(
      "legacy-request-composition",
    );
  });

  it("publishes canonical experiment operations", () => {
    expect(document.paths).toHaveProperty("/api/v1/experiments");
    expect(document.paths).toHaveProperty("/api/v1/experiments/{id}");
    expect(document.paths).toHaveProperty(
      "/api/v1/experiments/{id}/executions",
    );
    expect(document.paths).toHaveProperty(
      "/api/v1/experiments/{id}/executions/{experimentExecutionId}",
    );
    expect(document.paths).toHaveProperty("/api/v1/experiments/{id}/retry");
    expect(
      Object.keys(document.paths ?? {}).filter((path) =>
        path.includes("submission"),
      ),
    ).toEqual([]);
    expect(
      JSON.stringify(document.components?.schemas?.CreateExperimentInput),
    ).not.toContain('"tags"');
    expect(
      JSON.stringify(document.components?.schemas?.ExperimentResponse),
    ).not.toContain('"tags"');
  });

  it("keeps POST /requests active while deprecating only composition properties", () => {
    const operation = document.paths?.["/api/v1/requests"]?.post;
    expect(operation?.deprecated).not.toBe(true);
    const requestSchema = document.components?.schemas?.CreateRequestInput;
    const operationJson = JSON.stringify(operation);
    const requestSchemaJson = JSON.stringify(requestSchema);

    expect(operationJson).toContain('"count"');
    expect(operationJson).toContain('"deprecated":true');
    expect(requestSchemaJson).toContain('"profileVariations"');
    expect(requestSchemaJson).toContain('"deprecated":true');
    expect(operationJson).toContain("POST /api/v1/experiments");
    expect(requestSchemaJson).toContain("POST /api/v1/experiments");
  });
});
