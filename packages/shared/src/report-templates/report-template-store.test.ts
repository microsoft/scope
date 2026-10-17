// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Collection, Document } from "mongodb";
import { describe, expect, it } from "vitest";
import type {
  ReportTemplateDocument,
  ReportTemplateVersionDocument,
} from "../types/types.js";
import {
  canonicalReportTemplateContent,
  fingerprintReportTemplateContent,
  ReportTemplateStore,
} from "./report-template-store.js";

function memoryCollection<T extends Document>() {
  const documents: T[] = [];
  const matches = (document: T, filter: Document) =>
    Object.entries(filter).every(([key, expected]) => {
      const actual = document[key];
      if (
        expected &&
        typeof expected === "object" &&
        "$exists" in expected
      ) {
        return (
          (actual !== undefined) ===
          Boolean((expected as { $exists: unknown }).$exists)
        );
      }
      return actual === expected;
    });
  return {
    documents,
    find(filter: Document) {
      const values = documents.filter((document) => matches(document, filter));
      return {
        sort: () => ({
          toArray: async () => structuredClone(values),
        }),
      };
    },
    async findOne(filter: Document, options?: { sort?: { version: number } }) {
      const values = documents.filter((document) => matches(document, filter));
      if (options?.sort?.version === -1) {
        values.sort(
          (left, right) =>
            Number(right.version ?? 0) - Number(left.version ?? 0),
        );
      }
      return structuredClone(values[0] ?? null);
    },
    async insertOne(document: T) {
      documents.push(structuredClone(document));
      return { acknowledged: true };
    },
    async deleteOne(filter: Document) {
      const index = documents.findIndex((document) => matches(document, filter));
      if (index >= 0) documents.splice(index, 1);
      return { deletedCount: index >= 0 ? 1 : 0 };
    },
    async findOneAndUpdate(
      filter: Document,
      update: { $set?: Document; $unset?: Document },
    ) {
      const document = documents.find((candidate) => matches(candidate, filter));
      if (!document) return null;
      Object.assign(document, structuredClone(update.$set ?? {}));
      for (const key of Object.keys(update.$unset ?? {})) delete document[key];
      return structuredClone(document);
    },
    async updateOne(filter: Document, update: { $set?: Document }) {
      const document = documents.find((candidate) => matches(candidate, filter));
      if (!document) return { modifiedCount: 0 };
      Object.assign(document, structuredClone(update.$set ?? {}));
      return { modifiedCount: 1 };
    },
  };
}

function store() {
  const templates = memoryCollection<ReportTemplateDocument>();
  const versions = memoryCollection<ReportTemplateVersionDocument>();
  return {
    templates,
    versions,
    store: new ReportTemplateStore({
      templates: templates as unknown as Collection<ReportTemplateDocument>,
      versions: versions as unknown as Collection<ReportTemplateVersionDocument>,
    }),
  };
}

describe("ReportTemplateStore", () => {
  it("canonicalizes unordered linked template sets into one content identity", () => {
    const left = canonicalReportTemplateContent({
      userPrompt: " Summarize ",
      trigger: {
        type: "run-report-templates",
        reportTemplateIds: ["quality", "security", "quality"],
      },
    });
    const right = canonicalReportTemplateContent({
      userPrompt: "Summarize",
      trigger: {
        type: "run-report-templates",
        reportTemplateIds: ["security", "quality"],
      },
    });

    expect(left).toEqual(right);
    expect(fingerprintReportTemplateContent(left)).toBe(
      fingerprintReportTemplateContent(right),
    );
  });

  it("keeps immutable history and avoids a new version for metadata-only edits", async () => {
    const context = store();
    const created = await context.store.create({
      projectId: "project-1",
      id: "summary",
      subject: "experiment",
      name: "Summary",
      userPrompt: "Summarize the evidence.",
    });
    const renamed = await context.store.update("project-1", "summary", {
      name: "Executive summary",
      enabled: false,
    });
    const changed = await context.store.update("project-1", "summary", {
      userPrompt: "Summarize the evidence and risks.",
    });

    expect(renamed.currentVersion).toBe(1);
    expect(changed.currentVersion).toBe(2);
    expect(context.versions.documents).toHaveLength(2);
    expect(context.versions.documents[0]).toMatchObject({
      _id: created.currentVersionId,
      version: 1,
      userPrompt: "Summarize the evidence.",
    });
    expect(context.versions.documents[1]).toMatchObject({
      _id: changed.currentVersionId,
      version: 2,
      userPrompt: "Summarize the evidence and risks.",
    });
  });

  it("scopes lookup, updates, and deletion by project", async () => {
    const context = store();
    await context.store.create({
      projectId: "project-1",
      id: "summary",
      subject: "experiment",
      name: "Summary",
      userPrompt: "Project one",
    });
    await context.store.create({
      projectId: "project-2",
      id: "summary",
      subject: "experiment",
      name: "Summary",
      userPrompt: "Project two",
    });

    expect(await context.store.get("project-1", "summary")).toMatchObject({
      projectId: "project-1",
      userPrompt: "Project one",
    });
    await context.store.softDelete("project-1", "summary");
    expect(await context.store.get("project-1", "summary")).toBeNull();
    expect(await context.store.get("project-2", "summary")).toMatchObject({
      projectId: "project-2",
      userPrompt: "Project two",
    });
  });
});
