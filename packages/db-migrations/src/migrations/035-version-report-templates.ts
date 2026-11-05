// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash } from "node:crypto";
import type { Db, Document } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";

function canonicalTrigger(trigger: Document | undefined): Document | undefined {
  if (!trigger) return undefined;
  const arrayKey =
    trigger.type === "criteria"
      ? "criteriaIds"
      : trigger.type === "taskPrompt"
        ? "taskPromptIds"
        : trigger.type === "promptFeature"
          ? "featureIds"
          : trigger.type === "run-report-templates"
            ? "reportTemplateIds"
            : undefined;
  if (!arrayKey || !Array.isArray(trigger[arrayKey])) return trigger;
  return {
    ...trigger,
    [arrayKey]: [...new Set(trigger[arrayKey] as string[])].sort(),
  };
}

function contentFor(template: Document): Document {
  return {
    userPrompt: String(template.userPrompt ?? "").trim(),
    ...(template.systemPrompt
      ? {
          systemPrompt: {
            mode: template.systemPrompt.mode,
            content: String(template.systemPrompt.content ?? "").trim(),
          },
        }
      : {}),
    ...(template.trigger
      ? { trigger: canonicalTrigger(template.trigger as Document) }
      : {}),
    ...(template.model ? { model: template.model } : {}),
    ...(template.timeoutMs !== undefined
      ? { timeoutMs: template.timeoutMs }
      : {}),
  };
}

function fingerprint(value: Document): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("base64url");
}

function versionId(projectId: string, templateId: string): string {
  return `rtv_v1_${createHash("sha256")
    .update(JSON.stringify([projectId, templateId, 1]))
    .digest("base64url")}`;
}

export class VersionReportTemplates implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const templates = db.collection<Document>("report-templates");
    const versions = db.collection<Document>("report-template-versions");
    const cursor = templates.find({
      $or: [
        { subject: { $exists: false } },
        { enabled: { $exists: false } },
        { currentVersionId: { $exists: false } },
      ],
    });
    while (await cursor.hasNext()) {
      const template = await cursor.next();
      if (!template) continue;
      const projectId = String(template.projectId);
      const templateId = String(template.id);
      const content = contentFor(template);
      const contentFingerprint = fingerprint(content);
      const currentVersionId = versionId(projectId, templateId);
      await versions.updateOne(
        { _id: currentVersionId } as Document,
        {
          $setOnInsert: {
            _id: currentVersionId,
            projectId,
            templateId,
            version: 1,
            contentFingerprint,
            ...content,
            createdAt: template.createdAt ?? new Date(),
          } as Document,
        },
        { upsert: true },
      );
      await templates.updateOne(
        { _id: template._id },
        {
          $set: {
            subject: template.subject ?? "run",
            enabled: template.enabled ?? true,
            currentVersionId,
            currentVersion: 1,
            contentFingerprint,
          },
        },
      );
    }

    const indexes: Array<{
      collection: string;
      keys: Document;
      options?: Document;
    }> = [
      {
        collection: "report-templates",
        keys: { projectId: 1, subject: 1 },
      },
      {
        collection: "report-template-versions",
        keys: { projectId: 1 },
      },
      {
        collection: "report-template-versions",
        keys: { templateId: 1, version: -1 },
        options: { unique: true },
      },
      {
        collection: "reports",
        keys: { experimentExecutionId: 1, templateId: 1 },
      },
      {
        collection: "reports",
        keys: { templateVersionId: 1 },
      },
      {
        collection: "reports",
        keys: {
          experimentExecutionId: 1,
          templateId: 1,
          reportVersion: 1,
        },
      },
      {
        collection: "reports",
        keys: { requestId: 1, runId: 1, templateId: 1 },
      },
    ];
    for (const index of indexes) {
      try {
        await db
          .collection(index.collection)
          .createIndex(index.keys, index.options);
        console.log(
          `[035] Created ${index.collection} index ${JSON.stringify(index.keys)}`,
        );
      } catch (error) {
        console.log(
          `[035] Index already exists or could not be created: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  async down(): Promise<void> {
    console.log(
      "[035-down] Skipping report-template version/index removal; remove manually if required",
    );
  }
}
