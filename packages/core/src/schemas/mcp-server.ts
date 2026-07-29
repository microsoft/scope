// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const McpTransportTypeSchema = z.enum(["sse", "http", "stdio"]);

export const McpServerHeaderSchema = z
  .object({
    name: z.string(),
    value: z.string(),
  })
  .openapi("McpServerHeader");

export const CreateMcpServerInputSchema = z
  .object({
    name: z.string(),
    type: McpTransportTypeSchema,
    url: z.string().optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    headers: z.array(McpServerHeaderSchema).optional(),
    sessionMode: z.enum(["stateful", "stateless"]).optional(),
    version: z.string().optional(),
    description: z.string().optional(),
  })
  .openapi("CreateMcpServerInput");

export const UpdateMcpServerInputSchema = z
  .object({
    name: z.string().optional(),
    type: McpTransportTypeSchema.optional(),
    url: z.string().optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    headers: z.array(McpServerHeaderSchema).optional(),
    sessionMode: z.enum(["stateful", "stateless"]).optional(),
    version: z.string().optional(),
    description: z.string().optional(),
  })
  .refine(
    (data) => !(data.env !== undefined && data.headers !== undefined),
    { message: "Only one of 'env' or 'headers' may be provided" },
  )
  .openapi("UpdateMcpServerInput");

export const McpServerResponseSchema = z
  .object({
    _id: z.string(),
    name: z.string(),
    type: McpTransportTypeSchema,
    url: z.string().optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    headers: z.array(McpServerHeaderSchema).optional(),
    sessionMode: z.enum(["stateful", "stateless"]).optional(),
    version: z.string().optional(),
    description: z.string().optional(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    deletedAt: z.coerce.date().optional(),
  })
  .openapi("McpServerResponse");
