// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Db, Document } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { VersionReportTemplates } from "./migrations/035-version-report-templates.js";

describe("migration 035: version report templates", () => {
  it("backfills legacy templates idempotently and creates focused indexes", async () => {
    const legacy = {
      _id: "mongo-template-1",
      projectId: "project-1",
      id: "quality",
      name: "Quality",
      userPrompt: " Summarize quality ",
      trigger: { type: "criteria", criteriaIds: ["b", "a", "b"] },
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const templateUpdates: Document[] = [];
    const versionUpdates: Document[] = [];
    const indexes = new Map<string, ReturnType<typeof vi.fn>>();
    const cursor = {
      values: [legacy],
      async hasNext() {
        return this.values.length > 0;
      },
      async next() {
        return this.values.shift() ?? null;
      },
    };
    const db = {
      collection: vi.fn((name: string) => {
        const createIndex =
          indexes.get(name) ??
          vi.fn(async () => `${name}-index`);
        indexes.set(name, createIndex);
        if (name === "report-templates") {
          return {
            find: vi.fn(() => cursor),
            updateOne: vi.fn(async (_filter, update) => {
              templateUpdates.push(update);
              return { modifiedCount: 1 };
            }),
            createIndex,
          };
        }
        if (name === "report-template-versions") {
          return {
            updateOne: vi.fn(async (_filter, update) => {
              versionUpdates.push(update);
              return { modifiedCount: 1 };
            }),
            createIndex,
          };
        }
        return { createIndex };
      }),
    } as unknown as Db;

    await new VersionReportTemplates().up(db);

    expect(versionUpdates[0]?.$setOnInsert).toMatchObject({
      projectId: "project-1",
      templateId: "quality",
      version: 1,
      userPrompt: "Summarize quality",
      trigger: { type: "criteria", criteriaIds: ["a", "b"] },
    });
    expect(templateUpdates[0]?.$set).toMatchObject({
      subject: "run",
      enabled: true,
      currentVersion: 1,
    });
    expect(indexes.get("report-template-versions")).toHaveBeenCalledWith(
      { templateId: 1, version: -1 },
      { unique: true },
    );
    expect(indexes.get("reports")).toHaveBeenCalledWith(
      {
        experimentExecutionId: 1,
        templateId: 1,
        reportVersion: 1,
      },
      undefined,
    );
  });
});
