// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const AgentVersionSchema = z
  .object({
    agentVersion: z.string(),
    workerVersion: z.string(),
    components: z.record(z.string(), z.string()),
    gitCommit: z.string(),
    buildTime: z.string(),
    imageTag: z.string(),
    queueName: z.string(),
    status: z.enum(["active", "retired"]),
    createdAt: z.coerce.date(),
  })
  .openapi("AgentVersion");

export const CreateAgentInputSchema = z
  .object({
    _id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    modelProvider: z.string().optional(),
    supportedModels: z.array(z.string()).optional(),
    defaultModel: z.string().optional(),
    available: z.boolean().optional(),
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
    versions: z.array(AgentVersionSchema).optional(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    deletedAt: z.coerce.date().optional(),
  })
  .openapi("AgentResponse");

export const RegisterAgentVersionInputSchema = z
  .object({
    agentVersion: z.string(),
    workerVersion: z.string(),
    components: z.record(z.string(), z.string()),
    gitCommit: z.string(),
    buildTime: z.string(),
    imageTag: z.string(),
    queueName: z.string(),
  })
  .openapi("RegisterAgentVersionInput");

export const PatchAgentVersionInputSchema = z
  .object({
    status: z.enum(["active", "retired"]),
  })
  .openapi("PatchAgentVersionInput");
