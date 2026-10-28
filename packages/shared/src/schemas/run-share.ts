// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";

export const RUN_SHARE_HEADER = "X-Scope-Run-Share";
export const RUN_SHARE_PAGE = "/shared/runs";
export const RunShareTokenSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/,
);

export const RunShareContentSchema = z.object({
  prompts: z.boolean(),
  evaluationDetails: z.boolean(),
  conversations: z.boolean(),
  logs: z.boolean(),
  reports: z.boolean(),
  snapshots: z.boolean(),
  network: z.boolean(),
  video: z.boolean(),
}).strict();
export type RunShareContent = z.infer<typeof RunShareContentSchema>;
export type RunShareCategory = keyof RunShareContent;

export const SUMMARY_SHARE_CONTENT: Readonly<RunShareContent> = Object.freeze({
  prompts: false,
  evaluationDetails: false,
  conversations: false,
  logs: false,
  reports: false,
  snapshots: false,
  network: false,
  video: false,
});
export const FULL_SHARE_CONTENT: Readonly<RunShareContent> = Object.freeze({
  ...SUMMARY_SHARE_CONTENT,
  prompts: true,
  evaluationDetails: true,
  conversations: true,
  logs: true,
  reports: true,
});

export const RUN_SHARE_CATEGORIES: ReadonlyArray<{
  key: RunShareCategory;
  label: string;
  description: string;
}> = [
  { key: "prompts", label: "Prompts", description: "Task, gate prompts, persona instructions, and AGENTS.md." },
  { key: "evaluationDetails", label: "Evaluation explanations", description: "Judge feedback, per-criterion explanations, result, and errors." },
  { key: "conversations", label: "Conversations", description: "Agent responses and tool calls. Raw transcripts require prompts and explanations too." },
  { key: "logs", label: "Logs", description: "Persisted run logs, which may contain prompts, code, and sensitive values." },
  { key: "reports", label: "Reports", description: "Reports verified as belonging to this attempt; may quote other run content." },
  { key: "snapshots", label: "Source archives", description: "Raw workspace snapshots, including generated files and any embedded secrets." },
  { key: "network", label: "Network captures", description: "Raw HAR downloads, which may contain credentials, prompts, and network traffic." },
  { key: "video", label: "Videos", description: "Screen recordings, which may show private or sensitive content." },
];

export function hasDetailedShareContent(content: RunShareContent): boolean {
  return Object.values(content).some(Boolean);
}

const expiresAt = z.string().datetime({ offset: true }).nullable();
const policyFields = {
  label: z.string().trim().min(1).max(80),
  content: RunShareContentSchema,
  expiresAt,
  acknowledgeSensitiveContent: z.boolean().optional(),
};
export const CreateRunShareSchema = z.object({
  ...policyFields,
  label: policyFields.label.default("Shared run"),
  content: policyFields.content.default({ ...SUMMARY_SHARE_CONTENT }),
  expiresAt: expiresAt.optional(),
}).strict().refine(
  (value) => !hasDetailedShareContent(value.content) || value.acknowledgeSensitiveContent === true,
  { path: ["acknowledgeSensitiveContent"], message: "Confirm that the selected content may contain sensitive data" },
);
export const UpdateRunShareSchema = z.object(policyFields).partial().strict()
  .refine((value) => value.label !== undefined || value.content !== undefined || value.expiresAt !== undefined, {
    message: "Provide a label, content policy, or expiry",
  })
  .refine(
    (value) => !value.content || !hasDetailedShareContent(value.content) || value.acknowledgeSensitiveContent === true,
    { path: ["acknowledgeSensitiveContent"], message: "Confirm that the selected content may contain sensitive data" },
  );
export type CreateRunShare = z.input<typeof CreateRunShareSchema>;
export type UpdateRunShare = z.infer<typeof UpdateRunShareSchema>;

export const RunShareSchema = z.object({
  id: z.string().uuid(),
  requestId: z.string(),
  runId: z.string(),
  label: z.string(),
  content: RunShareContentSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt,
  revokedAt: z.string().datetime().nullable(),
});
export type RunShare = z.infer<typeof RunShareSchema>;
export const RunShareLinkSchema = z.object({ share: RunShareSchema, path: z.string() });
export type RunShareLink = z.infer<typeof RunShareLinkSchema>;
export const RunShareListSchema = z.object({
  data: z.array(RunShareSchema),
  next: z.string().uuid().nullable(),
});
export type RunShareList = z.infer<typeof RunShareListSchema>;

const PublicCriterionSchema = z.object({
  criterionId: z.string(),
  passed: z.boolean(),
  evaluated: z.boolean(),
  feedback: z.string().optional(),
});
const PublicTurnSchema = z.object({
  iteration: z.number(),
  gate: z.string().optional(),
  passed: z.boolean(),
  timestamp: z.string().datetime(),
  durationMs: z.number().optional(),
  criteriaResults: z.array(PublicCriterionSchema),
  codingAgentResponse: z.string().optional(),
  judgeFeedback: z.string().optional(),
  toolCalls: z.array(z.object({
    name: z.string(),
    arguments: z.record(z.string(), z.unknown()),
    response: z.string().optional(),
  })).optional(),
});
export const SharedRunArtifactSchema = z.object({
  id: z.string(),
  label: z.string(),
  category: z.enum(["conversations", "snapshots", "network", "video"]),
  contentType: z.string(),
});
export type SharedRunArtifact = z.infer<typeof SharedRunArtifactSchema>;
export const SharedRunSchema = z.object({
  version: z.literal(1),
  label: z.string(),
  content: RunShareContentSchema,
  expiresAt,
  run: z.object({
    attemptNumber: z.number(),
    status: z.enum(["pending", "queued", "processing", "paused", "done"]),
    outcome: z.enum(["succeeded", "failed", "finished"]).optional(),
    workerType: z.string(),
    model: z.string().optional(),
    agentVersion: z.string().optional(),
    startedAt: z.string().datetime().optional(),
    finishedAt: z.string().datetime().optional(),
    durationMs: z.number().optional(),
    result: z.string().optional(),
    error: z.string().optional(),
    turns: z.array(PublicTurnSchema),
  }),
  prompts: z.array(z.object({ label: z.string(), text: z.string().nullable() })).optional(),
  artifacts: z.array(SharedRunArtifactSchema),
});
export type SharedRun = z.infer<typeof SharedRunSchema>;
export const SharedRunReportsSchema = z.object({
  data: z.array(z.object({
    id: z.string(),
    label: z.string(),
    content: z.string(),
    createdAt: z.string().datetime(),
  })),
  next: z.string().nullable(),
});
export type SharedRunReports = z.infer<typeof SharedRunReportsSchema>;

export const SharedRunLogsSchema = z.object({
  events: z.array(z.object({
    timestamp: z.string(),
    level: z.enum(["info", "warn", "error", "debug"]),
    source: z.string().optional(),
    message: z.string(),
    data: z.record(z.string(), z.unknown()).optional(),
  })),
  truncated: z.boolean(),
});
