// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";

export const ServerWorkerTypeSchema = z.enum([
  "coder-acp-copilot",
  "coder-acp-copilot-host",
  "coder-acp-claude-code",
  "coder-acp-claude-code-host",
]);

export const ServerAgentStatusSchema = z.object({
  workerType: ServerWorkerTypeSchema,
  label: z.string(),
  runtime: z.enum(["host", "docker"]),
  enabled: z.boolean(),
  available: z.boolean(),
  executable: z.string().optional(),
  version: z.string().optional(),
  error: z.string().optional(),
});

export const ServerControlStatusSchema = z.object({
  agents: z.array(ServerAgentStatusSchema),
});

export const ServerStatusSchema = ServerControlStatusSchema.extend({
  enabled: z.boolean(),
});

export const ConfigureServerAgentSchema = z.object({
  enabled: z.boolean(),
  executable: z.string().trim().min(1).optional(),
  consent: z.boolean().optional(),
}).strict();

export type ServerWorkerType = z.infer<typeof ServerWorkerTypeSchema>;
export type ServerAgentStatus = z.infer<typeof ServerAgentStatusSchema>;
export type ServerStatus = z.infer<typeof ServerStatusSchema>;
export type ConfigureServerAgent = z.infer<typeof ConfigureServerAgentSchema>;
