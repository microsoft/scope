// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const AgentCapabilitiesSchema = z
  .object({
    supportsReasoningEffort: z.boolean().optional(),
    supportsMcpServers: z.boolean().optional(),
    supportsSkills: z.boolean().optional(),
    supportsExtensions: z.boolean().optional(),
    supportsResources: z.boolean().optional(),
  })
  .openapi("AgentCapabilities");

export const AgentVersionSchema = z
  .object({
    agentVersion: z.string().trim().min(1),
    workerVersion: z.string().trim().min(1),
    components: z.record(z.string(), z.string()),
    gitCommit: z.string().trim().min(1),
    buildTime: z.string().trim().min(1),
    imageTag: z.string().trim().min(1),
    queueName: z.string().optional(),
    status: z.enum(["active", "retired"]),
    createdAt: z.coerce.date(),
  })
  .openapi("AgentVersion");

export const CreateAgentInputSchema = z
  .object({
    _id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    description: z.string().optional(),
    modelProvider: z.string().optional(),
    supportedModels: z.array(z.string()).optional(),
    defaultModel: z.string().optional(),
    available: z.boolean().optional(),
    capabilities: AgentCapabilitiesSchema.optional(),
  })
  .openapi("CreateAgentInput");

export const UpdateAgentInputSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    modelProvider: z.string().optional(),
    supportedModels: z.array(z.string()).optional(),
    defaultModel: z.string().optional(),
    available: z.boolean().optional(),
    capabilities: AgentCapabilitiesSchema.optional(),
  })
  .openapi("UpdateAgentInput");

export const AgentResponseSchema = z
  .object({
    _id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    modelProvider: z.string().optional(),
    supportedModels: z.array(z.string()),
    defaultModel: z.string().optional(),
    available: z.boolean().optional(),
    capabilities: AgentCapabilitiesSchema.optional(),
    versions: z.array(AgentVersionSchema).optional(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    deletedAt: z.coerce.date().optional(),
  })
  .openapi("AgentResponse");

export const RegisterAgentVersionInputSchema = z
  .object({
    agentVersion: z.string().trim().min(1),
    workerVersion: z.string().trim().min(1),
    components: z.record(z.string(), z.string()),
    gitCommit: z.string().trim().min(1),
    buildTime: z.string().trim().min(1),
    imageTag: z.string().trim().min(1),
    queueName: z.string().trim().min(1),
  })
  .openapi("RegisterAgentVersionInput");

export const PatchAgentVersionInputSchema = z
  .object({
    status: z.enum(["active", "retired"]),
  })
  .openapi("PatchAgentVersionInput");
