// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import type { RouteContext } from "../route-context.js";
import { useTestServer } from "../test-server.js";
import { registerCriteriaRoutes } from "./criteria.js";
import { registerPromptFeaturesRoutes } from "./prompt-features.js";
import { registerReportTemplatesRoutes } from "./report-templates.js";
import { registerSkillsRoutes } from "./skills.js";
import { registerExtensionsRoutes } from "./extensions.js";
import { registerInsightsRoutes } from "./insights.js";

/** Compile the Mongo regex clauses so invalid search patterns fail at the boundary. */
function searchPatterns(value: unknown): RegExp[] {
  if (!value || typeof value !== "object") return [];
  if ("$regex" in value && typeof value.$regex === "string") {
    return [new RegExp(value.$regex, "i")];
  }
  return Object.values(value).flatMap(searchPatterns);
}

const routes = [
  { path: "/criteria", register: registerCriteriaRoutes, collection: "criteriaCollection" },
  { path: "/prompt-features", register: registerPromptFeaturesRoutes, collection: "promptFeatureCollection" },
  { path: "/report-templates", register: registerReportTemplatesRoutes, collection: "reportTemplateCollection" },
  { path: "/skills/search", register: registerSkillsRoutes, collection: "skillCollection" },
  { path: "/extensions/search", register: registerExtensionsRoutes, collection: "extensionCollection" },
  { path: "/insights", register: registerInsightsRoutes, collection: "insightsCollection" },
  { path: "/insights/search", register: registerInsightsRoutes, collection: "insightsCollection" },
];

describe.each(routes)("literal search $path", ({ path, register, collection }) => {
  const app = express();
  const testServer = useTestServer(app);
  let patterns: RegExp[];
  const cursor = { limit: () => cursor, sort: () => cursor, toArray: async () => [] };
  const find = vi.fn((filter: unknown) => {
    patterns = searchPatterns(filter);
    return cursor;
  });
  register({ app, registry: new OpenAPIRegistry(), [collection]: { find } } as unknown as RouteContext);

  beforeEach(() => {
    patterns = [];
    // Registry searches keep their original query; prevent real external requests.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ skills: [], results: [{ extensions: [] }] }),
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["[draft]", "draft"],
    ["C++", "CCC"],
    ["a.b", "axb"],
    ["[", "anything"],
  ])("matches %s literally without treating punctuation as regex", async (term, unrelated) => {
    const result = await request(testServer()).get(`/api/v1${path}`).query({ projectId: "project-a", q: term });

    expect(result.status).toBe(200);
    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) {
      expect(pattern.test(`prefix ${term.toUpperCase()} suffix`)).toBe(true);
      expect(pattern.test(unrelated)).toBe(false);
    }
  });
});
