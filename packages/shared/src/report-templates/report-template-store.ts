// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash, randomUUID } from "node:crypto";
import type { Collection, Document } from "mongodb";
import type {
  ReportTemplateDocument,
  ReportTemplateSystemPrompt,
  ReportTemplateVersionDocument,
  ReportTrigger,
} from "../types/types.js";

export interface ReportTemplateCollections {
  templates: Collection<ReportTemplateDocument>;
  versions: Collection<ReportTemplateVersionDocument>;
}

export interface ReportTemplateContent {
  userPrompt: string;
  systemPrompt?: ReportTemplateSystemPrompt;
  trigger?: ReportTrigger;
  model?: string;
  timeoutMs?: number;
}

function canonicalTrigger(trigger: ReportTrigger | undefined): ReportTrigger | undefined {
  if (!trigger) return undefined;
  switch (trigger.type) {
    case "criteria":
      return {
        ...trigger,
        criteriaIds: [...new Set(trigger.criteriaIds)].sort(),
      };
    case "taskPrompt":
      return {
        ...trigger,
        taskPromptIds: [...new Set(trigger.taskPromptIds)].sort(),
      };
    case "promptFeature":
      return {
        ...trigger,
        featureIds: [...new Set(trigger.featureIds)].sort(),
      };
    case "run-report-templates":
      return {
        ...trigger,
        reportTemplateIds: [...new Set(trigger.reportTemplateIds)].sort(),
      };
    default:
      return trigger;
  }
}

export function canonicalReportTemplateContent(
  content: ReportTemplateContent,
): ReportTemplateContent {
  return {
    userPrompt: content.userPrompt.trim(),
    ...(content.systemPrompt
      ? {
          systemPrompt: {
            mode: content.systemPrompt.mode,
            content: content.systemPrompt.content.trim(),
          },
        }
      : {}),
    ...(content.trigger ? { trigger: canonicalTrigger(content.trigger) } : {}),
    ...(content.model ? { model: content.model } : {}),
    ...(content.timeoutMs !== undefined ? { timeoutMs: content.timeoutMs } : {}),
  };
}

export function fingerprintReportTemplateContent(
  content: ReportTemplateContent,
): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalReportTemplateContent(content)))
    .digest("base64url");
}

export class ReportTemplateStore {
  constructor(private readonly collections: ReportTemplateCollections) {}

  async list(input: {
    projectId: string;
    subject?: "run" | "experiment";
    includeDisabled?: boolean;
  }): Promise<ReportTemplateDocument[]> {
    return this.collections.templates
      .find({
        projectId: input.projectId,
        deletedAt: { $exists: false },
        ...(input.subject ? { subject: input.subject } : {}),
        ...(input.includeDisabled ? {} : { enabled: true }),
      } as Document)
      .sort({ id: 1 })
      .toArray();
  }

  async get(
    projectId: string,
    id: string,
  ): Promise<ReportTemplateDocument | null> {
    return this.collections.templates.findOne({
      projectId,
      id,
      deletedAt: { $exists: false },
    } as Document);
  }

  async getVersion(input: {
    projectId: string;
    templateId: string;
    versionId?: string;
  }): Promise<ReportTemplateVersionDocument | null> {
    const filter: Document = {
      projectId: input.projectId,
      templateId: input.templateId,
      ...(input.versionId ? { _id: input.versionId } : {}),
    };
    return this.collections.versions.findOne(filter, {
      sort: input.versionId ? undefined : { version: -1 },
    });
  }

  async listVersions(
    projectId: string,
    templateId: string,
  ): Promise<ReportTemplateVersionDocument[]> {
    return this.collections.versions
      .find({ projectId, templateId })
      .sort({ version: -1 })
      .toArray();
  }

  async create(input: {
    projectId: string;
    id: string;
    subject: "run" | "experiment";
    name: string;
    description?: string;
    enabled?: boolean;
  } & ReportTemplateContent): Promise<ReportTemplateDocument> {
    if (!/^[a-z][a-z0-9_-]*$/.test(input.id)) {
      throw new Error(
        `Invalid report template ID '${input.id}'. Must start with a letter and match [a-z][a-z0-9_-]*`,
      );
    }
    if (!input.name.trim()) throw new Error("Report template name is required");
    if (!input.userPrompt.trim()) {
      throw new Error("Report template userPrompt is required");
    }
    const duplicate = await this.collections.templates.findOne({
      projectId: input.projectId,
      id: input.id,
      deletedAt: { $exists: false },
    } as Document);
    if (duplicate) {
      throw new Error(`Report template '${input.id}' already exists`);
    }

    const now = new Date();
    const content = canonicalReportTemplateContent(input);
    const version: ReportTemplateVersionDocument = {
      _id: randomUUID(),
      projectId: input.projectId,
      templateId: input.id,
      version: 1,
      contentFingerprint: fingerprintReportTemplateContent(content),
      ...content,
      createdAt: now,
    };
    const template: ReportTemplateDocument = {
      _id: randomUUID(),
      projectId: input.projectId,
      id: input.id,
      subject: input.subject,
      name: input.name.trim(),
      ...(input.description?.trim()
        ? { description: input.description.trim() }
        : {}),
      ...content,
      enabled: input.enabled ?? true,
      currentVersionId: version._id,
      currentVersion: version.version,
      contentFingerprint: version.contentFingerprint,
      createdAt: now,
    };
    await this.collections.versions.insertOne(version);
    try {
      await this.collections.templates.insertOne(template);
    } catch (error) {
      await this.collections.versions.deleteOne({ _id: version._id });
      throw error;
    }
    return template;
  }

  async update(
    projectId: string,
    id: string,
    patch: {
      name?: string;
      description?: string;
      enabled?: boolean;
      userPrompt?: string;
      systemPrompt?: ReportTemplateSystemPrompt | null;
      trigger?: ReportTrigger | null;
      model?: string | null;
      timeoutMs?: number | null;
    },
  ): Promise<ReportTemplateDocument> {
    const existing = await this.get(projectId, id);
    if (!existing) throw new Error(`Report template '${id}' not found`);
    if (patch.name !== undefined && !patch.name.trim()) {
      throw new Error("Report template name cannot be empty");
    }
    if (patch.userPrompt !== undefined && !patch.userPrompt.trim()) {
      throw new Error("Report template userPrompt cannot be empty");
    }

    const nextContent = canonicalReportTemplateContent({
      userPrompt: patch.userPrompt ?? existing.userPrompt,
      systemPrompt:
        patch.systemPrompt === null
          ? undefined
          : patch.systemPrompt ?? existing.systemPrompt,
      trigger:
        patch.trigger === null ? undefined : patch.trigger ?? existing.trigger,
      model: patch.model === null ? undefined : patch.model ?? existing.model,
      timeoutMs:
        patch.timeoutMs === null
          ? undefined
          : patch.timeoutMs ?? existing.timeoutMs,
    });
    const nextFingerprint = fingerprintReportTemplateContent(nextContent);
    const contentChanged = nextFingerprint !== existing.contentFingerprint;
    const now = new Date();
    let version: ReportTemplateVersionDocument | undefined;
    if (contentChanged) {
      version = {
        _id: randomUUID(),
        projectId,
        templateId: id,
        version: existing.currentVersion + 1,
        contentFingerprint: nextFingerprint,
        ...nextContent,
        createdAt: now,
      };
      await this.collections.versions.insertOne(version);
    }

    const $set: Document = {
      ...nextContent,
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.description !== undefined
        ? { description: patch.description.trim() }
        : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(version
        ? {
            currentVersionId: version._id,
            currentVersion: version.version,
            contentFingerprint: version.contentFingerprint,
          }
        : {}),
      updatedAt: now,
    };
    const $unset: Document = {};
    for (const key of ["systemPrompt", "trigger", "model", "timeoutMs"]) {
      if (!(key in nextContent)) $unset[key] = "";
    }
    const update: Document = { $set };
    if (Object.keys($unset).length > 0) update.$unset = $unset;
    const updated = await this.collections.templates.findOneAndUpdate(
      {
        _id: existing._id,
        projectId,
        currentVersionId: existing.currentVersionId,
      } as Document,
      update,
      { returnDocument: "after" },
    );
    if (!updated) {
      if (version) await this.collections.versions.deleteOne({ _id: version._id });
      throw new Error(`Report template '${id}' changed concurrently`);
    }
    return updated;
  }

  async softDelete(projectId: string, id: string): Promise<boolean> {
    const result = await this.collections.templates.updateOne(
      { projectId, id, deletedAt: { $exists: false } } as Document,
      { $set: { deletedAt: new Date(), updatedAt: new Date() } },
    );
    return result.modifiedCount === 1;
  }
}
