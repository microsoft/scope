// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type {
  CompletionOptions,
  ComposedPromptRequest,
  PromptToolDefinition,
} from "../protocol.js";

export interface ProductionChatRequest {
  messages: Array<{ role: "system" | "user"; content: string }>;
  model: string;
  temperature: number;
  max_tokens: number;
}

export function normalizeProductionChatRequest(
  adapterId: string,
  productionSources: string[],
  request: ProductionChatRequest,
  metadata?: Partial<ComposedPromptRequest["metadata"]>,
): ComposedPromptRequest {
  return {
    messages: request.messages,
    model: request.model,
    temperature: request.temperature,
    maxTokens: request.max_tokens,
    metadata: {
      adapterId,
      productionSources,
      fidelity: "exact",
      ...metadata,
    },
  };
}

export function normalizeTools(tools: unknown[]): PromptToolDefinition[] {
  return tools.map((tool, index) => {
    if (!tool || typeof tool !== "object") {
      return { name: `tool_${index}` };
    }
    const value = tool as Record<string, unknown>;
    return {
      name: typeof value.name === "string" ? value.name : `tool_${index}`,
      ...(typeof value.description === "string"
        ? { description: value.description }
        : {}),
      ...("parameters" in value ? { parameters: value.parameters } : {}),
    };
  });
}

export function toolExecutionOptions(tools: unknown[]): CompletionOptions {
  const handlers = new Map<
    string,
    (arguments_: unknown) => Promise<unknown> | unknown
  >();
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const value = tool as Record<string, unknown>;
    if (typeof value.name !== "string" || typeof value.handler !== "function") {
      continue;
    }
    handlers.set(
      value.name,
      value.handler as (arguments_: unknown) => Promise<unknown> | unknown,
    );
  }
  return {
    async executeTool(name, arguments_) {
      const handler = handlers.get(name);
      if (!handler) {
        throw new Error(`No local handler is available for tool '${name}'`);
      }
      return handler(arguments_);
    },
  };
}
