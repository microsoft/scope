// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { acquireInferenceClient } from "../../../apps/api/src/llm-token.js";
import { withRetry } from "../../../packages/shared/src/utils/retry.js";
import { callDecision, DecisionError, readDecisionConfig } from "../../../scripts/contribution-insights/decision.mjs";
import { fakeContributionReport } from "./targets/contribution-insights.js";
import { AdapterTransportError, AdapterValidationError } from "./validation.js";
import type {
  AdapterContext,
  CompletionOptions,
  CompletionResult,
  ComposedPromptRequest,
} from "./protocol.js";

interface InferenceToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

type InferenceChatMessage =
  | { role: "system" | "developer"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content?: string;
      tool_calls?: InferenceToolCall[];
    }
  | { role: "tool"; content?: string; tool_call_id: string };

interface InferenceResponseBody {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: InferenceToolCall[];
    };
  }>;
  error?: {
    message?: string;
  };
}

export function createProductionAdapterContext(
  configuredModel?: string,
): AdapterContext {
  let handlePromise:
    | ReturnType<typeof acquireInferenceClient>
    | undefined;

  return {
    model: configuredModel || process.env.PROMPT_EVAL_MODEL || process.env.LLM_MODEL || "gpt-4.1",
    async decide(input) {
      let config: ReturnType<typeof readDecisionConfig>;
      try {
        config = readDecisionConfig(process.env, true);
      } catch (error: unknown) {
        throw new AdapterTransportError(
          error instanceof Error ? error.message : "Microsoft-Decision-1 configuration is unavailable",
          { cause: error },
        );
      }
      if (!config) throw new AdapterTransportError("Microsoft-Decision-1 requires explicit contribution decision configuration");
      try {
        return await callDecision(config, input);
      } catch (error: unknown) {
        if (error instanceof DecisionError && /request failed|transport failed|timed out|rate.limit/i.test(error.message)) {
          throw new AdapterTransportError(error.message, { cause: error });
        }
        throw error;
      }
    },
    async complete(
      request: ComposedPromptRequest,
      options?: CompletionOptions,
    ): Promise<CompletionResult> {
      if (request.decisionRequest || request.metadata.adapterId.startsWith("contribution-decision/")) {
        throw new AdapterValidationError("Microsoft-Decision-1 requests must use decide, never chat completions");
      }
      const azure = azureOpenAIConfiguration(configuredModel);
      if (azure) {
        return completeWithAzureOpenAI(request, azure, options);
      }

      handlePromise ??= acquireInferenceClient();
      const handle = await handlePromise;
      const model =
        configuredModel ||
        process.env.PROMPT_EVAL_MODEL ||
        handle.model ||
        request.model ||
        process.env.LLM_MODEL ||
        "gpt-4.1";

      return completeWithToolLoop(
        request,
        model,
        options,
        async (messages) => {
          const response = await handle.client.path("/chat/completions").post({
            body: {
              messages,
              model,
              ...(request.temperature === undefined
                ? {}
                : { temperature: request.temperature }),
              ...(request.maxTokens === undefined
                ? {}
                : { max_tokens: request.maxTokens }),
              ...(request.tools?.length
                ? { tools: openAITools(request) }
                : {}),
            },
          });
          const body = response.body as InferenceResponseBody;
          if (!String(response.status).startsWith("2")) {
            throw new Error(
              `LLM request failed: ${body.error?.message || response.status}`,
            );
          }
          return body;
        },
        { source: handle.source, via: handle.via, model },
      );
    },
  };
}

export function createFakeAdapterContext(
  model = "fake-model",
): AdapterContext {
  return {
    model,
    async decide(input) {
      return callDecision(
        {
          endpoint: "https://offline-fake.invalid",
          deployment: "offline-fake-decision-1",
          auth: { kind: "api-key", value: "offline-fake-not-a-credential" },
        },
        input,
        async () => new Response(JSON.stringify({
          fake: true,
          note: "Offline fixed abstention fixture; not a Microsoft-Decision-1 inference or a production fallback.",
          model: "microsoft-decision-1",
          answers: {
            review_action: {
              type: "choice",
              choice: "manual-review-required",
              probabilities: {
                "prioritize-review": 0,
                "request-clarification": 0,
                "request-contributor-changes": 0,
                "maintainer-scope-decision": 0,
                "manual-review-required": 1,
              },
            },
          },
          usage: { input_tokens: 0, output_tokens: 0 },
        })),
      );
    },
    async complete(request): Promise<CompletionResult> {
      if (request.decisionRequest || request.metadata.adapterId.startsWith("contribution-decision/")) {
        throw new AdapterValidationError("Microsoft-Decision-1 requests must use decide, never chat completions");
      }
      const adapterId = request.metadata.adapterId;
      let content: string;
      if (adapterId.startsWith("criteria-authoring/")) {
        content = JSON.stringify({
          prompt: "The generated criterion is observable.",
          suggestedId: "generated_criterion",
        });
      } else if (adapterId.includes("dependency-suggestion/")) {
        content = '{"suggestions":[]}';
      } else if (adapterId.startsWith("task-prompt-")) {
        content = '{"taskPrompt":"Build the requested benchmark task."}';
      } else if (adapterId.startsWith("prompt-feature-authoring/")) {
        content = JSON.stringify({
          prompt: "The task prompt exhibits the requested characteristic.",
          suggestedId: "asks_for_characteristic",
          suggestedParents: [],
          suggestedChildren: [],
        });
      } else if (adapterId.startsWith("prompt-feature-extraction/")) {
        content = '{"results":[],"suggestedFeatures":[]}';
      } else if (adapterId === "judge-instructions/bundled") {
        const criterionIds = [
          ...request.messages[1].content.matchAll(/^\s*-\s+([^:]+):/gm),
        ].map((match) => match[1].trim());
        content = JSON.stringify({
          results: criterionIds.map((criterion) => ({
            criterion,
            passed: true,
            feedback: "Fake transport verdict.",
          })),
        });
      } else if (adapterId === "judge-instructions/independent") {
        content = "PASS:\nFake transport verdict.";
      } else if (adapterId.startsWith("developer-feedback/")) {
        content = "Apply the requested correction.";
      } else if (adapterId.startsWith("run-report/")) {
        content = "# Fake report";
      } else if (adapterId.startsWith("contribution-insights/")) {
        content = fakeContributionReport(request);
      } else {
        throw new Error(
          `Fake transport has no response for adapter '${adapterId}'`,
        );
      }
      return {
        content,
        metadata: { source: "fake", model },
      };
    },
  };
}

interface AzureOpenAIConfiguration {
  endpoint: string;
  apiKey: string;
  deployment: string;
  apiVersion: string;
}

interface AzureOpenAIResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: InferenceToolCall[];
    };
  }>;
  error?: {
    message?: string;
  };
}

function azureOpenAIConfiguration(
  configuredModel?: string,
): AzureOpenAIConfiguration | null {
  const endpoint =
    process.env.SCOPE_EVAL_AZURE_OPENAI_ENDPOINT ||
    process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey =
    process.env.SCOPE_EVAL_AZURE_OPENAI_API_KEY ||
    process.env.AZURE_OPENAI_API_KEY;
  const deployment =
    configuredModel ||
    process.env.SCOPE_EVAL_AZURE_OPENAI_DEPLOYMENT ||
    process.env.AZURE_OPENAI_DEPLOYMENT;
  if (!endpoint || !apiKey || !deployment) return null;
  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    apiKey,
    deployment,
    apiVersion:
      process.env.SCOPE_EVAL_AZURE_OPENAI_API_VERSION ||
      process.env.AZURE_OPENAI_API_VERSION ||
      "2024-10-21",
  };
}

async function completeWithAzureOpenAI(
  request: ComposedPromptRequest,
  config: AzureOpenAIConfiguration,
  options?: CompletionOptions,
): Promise<CompletionResult> {
  const url =
    `${config.endpoint}/openai/deployments/` +
    `${encodeURIComponent(config.deployment)}/chat/completions` +
    `?api-version=${encodeURIComponent(config.apiVersion)}`;
  return completeWithToolLoop(
    request,
    config.deployment,
    options,
    async (messages) => {
      const response = await withRetry(async () => {
      const current = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": config.apiKey,
        },
        body: JSON.stringify({
          messages,
          model: config.deployment,
          ...(request.temperature === undefined
            ? {}
            : { temperature: request.temperature }),
          ...(request.maxTokens === undefined
            ? {}
            : { max_completion_tokens: request.maxTokens }),
          ...(request.tools?.length
            ? {
                tools: openAITools(request),
              }
            : {}),
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!current.ok) {
        const body: unknown = await current.json().catch(() => undefined);
        const message =
          body &&
          typeof body === "object" &&
          "error" in body &&
          body.error &&
          typeof body.error === "object" &&
          "message" in body.error &&
          typeof body.error.message === "string"
            ? body.error.message
            : `HTTP ${current.status}`;
        const error = new Error(`Azure OpenAI request failed: ${message}`);
        Object.assign(error, { statusCode: current.status });
        throw error;
      }
        return current;
      }, {
        maxRetries: 5,
        baseDelayMs: 500,
        maxDelayMs: 30_000,
        isRetryable: (error) => {
          const status =
            error &&
            typeof error === "object" &&
            "statusCode" in error &&
            typeof error.statusCode === "number"
              ? error.statusCode
              : undefined;
          return (
            status === 429 ||
            (status !== undefined && [500, 502, 503, 504].includes(status)) ||
            (error instanceof TypeError &&
              /fetch|network|socket|timed out/i.test(error.message))
          );
        },
      });
      return (await response.json()) as AzureOpenAIResponse;
    },
    {
      source: "azure-openai",
      via: "api-key",
      model: config.deployment,
    },
  );
}

function openAITools(request: ComposedPromptRequest) {
  return request.tools?.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

async function completeWithToolLoop(
  request: ComposedPromptRequest,
  model: string,
  options: CompletionOptions | undefined,
  send: (messages: InferenceChatMessage[]) => Promise<InferenceResponseBody>,
  metadata: Record<string, unknown>,
): Promise<CompletionResult> {
  const messages: InferenceChatMessage[] = request.messages.map((message) => ({
    ...message,
  }));
  const toolCalls: Array<Record<string, unknown>> = [];
  const maxToolRounds = options?.maxToolRounds ?? 12;
  for (let round = 0; round <= maxToolRounds; round += 1) {
    const body = await send(messages);
    const message = body.choices?.[0]?.message;
    const pending = message?.tool_calls ?? [];
    if (pending.length === 0) {
      if (!message?.content) {
        throw new Error(
          body.error?.message ||
            `${metadata.source === "azure-openai" ? "Azure OpenAI" : "LLM"} returned an empty response`,
        );
      }
      return {
        content: message.content,
        metadata: {
          ...metadata,
          ...(toolCalls.length ? { toolCalls } : {}),
        },
      };
    }
    if (!options?.executeTool) {
      throw new Error(
        "LLM requested tools, but the adapter did not provide local tool handlers",
      );
    }
    if (round === maxToolRounds) {
      throw new Error(`LLM exceeded the ${maxToolRounds}-round tool-call limit`);
    }
    messages.push({
      role: "assistant",
      ...(message?.content ? { content: message.content } : {}),
      tool_calls: pending,
    });
    for (const call of pending) {
      let arguments_: unknown;
      try {
        arguments_ = JSON.parse(call.function.arguments || "{}");
      } catch {
        throw new Error(
          `LLM returned invalid JSON arguments for tool '${call.function.name}'`,
        );
      }
      const output = await options.executeTool(call.function.name, arguments_);
      toolCalls.push({
        id: call.id,
        type: "tool_call",
        name: call.function.name,
        arguments: arguments_,
        response: output,
      });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(output),
      });
    }
  }
  throw new Error("Tool-call loop terminated unexpectedly");
}
