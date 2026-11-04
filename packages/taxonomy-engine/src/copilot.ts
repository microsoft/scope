// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotClient } from "@github/copilot-sdk";
import type { ModelInfo } from "@github/copilot-sdk";
import type {
  AxAIService,
  AxAIServiceOptions,
  AxChatRequest,
  AxChatResponse,
} from "@ax-llm/ax";
import {
  AxAssertionError,
  AxGenerateError,
} from "@ax-llm/ax";
import type {
  AttemptProvenance,
  ValidationDiagnostic,
} from "./assessment.js";
import type {
  PromptExecutionResult,
  PromptExecutor,
} from "./engine.js";
import { validateParsedAssessment } from "./evidence.js";
import { boundedErrorMessage } from "./errors.js";
import {
  ASSESSMENT_EXACT_KEYS,
  createTaxonomyPromptProgram,
  taxonomyPromptEvidence,
} from "./prompt.js";
import { executeSdkCall } from "./sdk-call.js";
import type { TaxonomyInput as LoadedTaxonomyInput } from "./scope-atif.js";

export {
  createTaxonomyPromptProgram,
  taxonomyPromptEvidence,
} from "./prompt.js";
export const DEFAULT_MODEL = "gpt-5.6-sol-fast";

/** Flattens only Ax text content parts; media and other rich parts stay rejected. */
export function axTextMessageContent(
  content: string | readonly unknown[] | undefined,
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    throw new Error("Only text messages are supported");
  }
  return content.map(part => {
    if (
      !part ||
      typeof part !== "object" ||
      part.type !== "text" ||
      typeof part.text !== "string"
    ) {
      throw new Error("Only scalar text or text-only message arrays are supported");
    }
    return part.text;
  }).join("");
}

/** Provider usage fields exposed by SDK assistant-usage events. */
export interface CopilotUsage {
  /** Model ID actually reported by the SDK. */
  model?: string;
  /** Prompt tokens charged for the request. */
  inputTokens?: number;
  /** Generated tokens charged for the request. */
  outputTokens?: number;
  /** Other SDK usage fields retained without interpretation. */
  [key: string]: unknown;
}

/** One text completion returned by the transport. */
export interface CopilotCompletion {
  /** Assistant text consumed by Ax. */
  content: string;
  /** Provider usage when exposed; absence means unknown, not zero. */
  usage?: CopilotUsage;
}

/** One text-only completion transport backed by an isolated Copilot SDK client. */
export interface CopilotTransport {
  /**
   * Sends one system/user pair.
   *
   * @param system - Trusted system text installed with replace semantics.
   * @param user - Model-visible text envelope containing Ax roles/evidence.
   * @param signal - Optional cancellation signal forwarded to the SDK lifecycle.
   * @returns Assistant text and provider usage fields when available.
   */
  complete(
    system: string,
    user: string,
    signal?: AbortSignal,
  ): Promise<CopilotCompletion>;
  /** Whether the transport can safely accept another completion. */
  isHealthy?(): boolean;
  /** Stops the SDK process and removes its isolated temporary home. */
  close(): Promise<void>;
}

/**
 * Attempts every close independently, preserving a primary failure alongside cleanup failures.
 *
 * @param transports - Student/teacher transports to close exactly once each.
 * @param primary - Optional failure from the operation that preceded cleanup.
 */
export async function closeTransports(
  transports: readonly Pick<CopilotTransport, "close">[],
  primary?: unknown,
): Promise<void> {
  const closed = await Promise.allSettled(transports.map(async transport => transport.close()));
  const errors = closed.flatMap(result => result.status === "rejected" ? [result.reason as unknown] : []);

  if (primary !== undefined && !errors.length) {
    throw primary;
  }
  if (primary !== undefined || errors.length) {
    throw new AggregateError([...(primary !== undefined ? [primary] : []), ...errors], "Copilot SDK operation/cleanup failed");
  }
}

const SDK_AUTH_ENVIRONMENT_VARIABLES = [
  "COPILOT_GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
] as const;

/** Resolved in-memory credential and its non-secret source. */
export interface CopilotCredential {
  /** GitHub token passed directly to the SDK client. */
  token: string;
  /** Credential source without the secret value. */
  source: "environment" | "gh-cli";
}

/** Injectable credential boundaries used by offline tests. */
export interface CopilotCredentialOptions {
  /** Host environment checked in SDK-supported priority order. */
  environment?: NodeJS.ProcessEnv;
  /** Active GitHub CLI account token lookup. */
  readGhToken?: () => Promise<string | undefined>;
}

/** Session-level transport settings that callers may deliberately override. */
export interface OpenCopilotTransportOptions {
  /**
   * Reasoning effort for standalone Taxonome callers. Pass `false` to let the
   * provider choose and avoid sending an unsupported effort.
   */
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | false;
}

/** Rejects an explicit unavailable model while preserving provider `auto`. */
export function validateConfiguredModel(
  model: string,
  availableModels: readonly ModelInfo[],
): void {
  if (model === "auto") return;
  if (availableModels.some((candidate) => candidate.id === model)) return;

  throw new Error(
    `Configured Taxonome model '${model}' is not available from the Copilot SDK`,
  );
}

/** Reads the active GitHub CLI token without using a shell or exposing stderr. */
async function readActiveGhToken(): Promise<string | undefined> {
  return new Promise(resolve => {
    try {
      const child = execFile("gh", ["auth", "token"], {
        encoding: "utf8",
        env: process.env,
        maxBuffer: 1024 * 1024,
        timeout: 10_000,
        windowsHide: true,
      }, (error, stdout) => {
        resolve(error ? undefined : String(stdout).trim() || undefined);
      });
      // Credential lookup is non-interactive and must never consume caller input.
      child.stdin?.destroy();
    } catch {
      resolve(undefined);
    }
  });
}

/** Resolves a supported environment override or the active GitHub CLI account. */
export async function resolveCopilotCredential(
  options: CopilotCredentialOptions = {},
): Promise<CopilotCredential> {
  const environment = options.environment ?? process.env;
  for (const name of SDK_AUTH_ENVIRONMENT_VARIABLES) {
    const token = environment[name]?.trim();
    if (token) return { token, source: "environment" };
  }

  let ghToken: string | undefined;
  try {
    ghToken = await (options.readGhToken ?? readActiveGhToken)();
  } catch {
    ghToken = undefined;
  }
  const token = ghToken?.trim();
  if (token) return { token, source: "gh-cli" };

  throw new Error(
    "GitHub authentication is unavailable; run `gh auth login` or set " +
    "COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN",
  );
}

/** Builds the narrow environment for the isolated SDK process. */
function copilotRuntimeEnvironment(sessionDirectory: string): Record<string, string> {
  const environment: Record<string, string> = { HOME: sessionDirectory };
  for (const name of ["PATH", "TMPDIR"]) {
    const value = process.env[name];
    if (value?.trim()) environment[name] = value;
  }
  return environment;
}

/**
 * Opens an isolated, tool-free SDK client using the SDK's normal authentication resolution.
 * The caller owns close(); a failed submission requires a fresh transport.
 *
 * @param model - Exact model ID used for session creation and usage verification.
 * @param resolveCredential - Injectable credential resolution for offline tests.
 * @param options - Session settings; standalone callers retain low effort by default.
 * @returns Text-only transport. Callers must invoke `close`.
 */
export async function openCopilotTransport(
  model: string,
  resolveCredential = resolveCopilotCredential,
  options: OpenCopilotTransportOptions = {},
): Promise<CopilotTransport> {
  const credential = await resolveCredential();
  const sessionDirectory = await mkdtemp(join(tmpdir(), "taxonome-sdk-"));
  const client = new CopilotClient({
    mode: "empty",
    gitHubToken: credential.token,
    useLoggedInUser: false,
    baseDirectory: sessionDirectory,
    workingDirectory: sessionDirectory,
    logLevel: "error",
    // Credential resolution already ran host-side. The SDK child receives only
    // a temporary home and process-launch essentials.
    env: copilotRuntimeEnvironment(sessionDirectory),
  });

  /** Stops the runtime and removes its isolated home, reporting both failures if needed. */
  async function cleanup() {
    const errors: unknown[] = [];
    try {
      await client.stop();
    } catch (error) {
      errors.push(error);
    }

    try {
      await rm(sessionDirectory, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }

    if (errors.length) {
      throw new AggregateError(errors, "Copilot SDK client cleanup failed");
    }
  }

  try {
    await client.start();
    if (!(await client.getAuthStatus()).isAuthenticated) {
      throw new Error(
        "Copilot SDK rejected the resolved GitHub credential; run `gh auth login` " +
        "or set COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN",
      );
    }
    validateConfiguredModel(model, await client.listModels());
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Copilot SDK initialization and cleanup failed");
    }
    throw error;
  }

  let failed = false;
  return {
    /**
     * Creates one isolated tool-free session and delegates guarded submission.
     *
     * @param system - Trusted system prompt installed with replace semantics.
     * @param user - Model-visible Ax text envelope.
     * @param signal - Optional caller cancellation signal.
     */
    async complete(system, user, signal) {
      if (failed) {
        throw new Error(
          "Previous SDK call failed; start a new transport before another live invocation",
        );
      }

      const configuredReasoningEffort =
        options.reasoningEffort === undefined
          ? "low"
          : options.reasoningEffort;
      const session = await client.createSession({
        // Empty mode plus explicit denials prevents ambient tools, instructions, skills, and storage.
        model,
        ...(configuredReasoningEffort === false
          ? {}
          : { reasoningEffort: configuredReasoningEffort }),
        availableTools: [],
        tools: [],
        mcpServers: {},
        skillDirectories: [],
        pluginDirectories: [],
        instructionDirectories: [],
        customAgents: [],
        skipCustomInstructions: true,
        enableConfigDiscovery: false,
        enableSkills: false,
        enableFileHooks: false,
        enableHostGitOperations: false,
        enableSessionStore: false,
        enableOnDemandInstructionDiscovery: false,
        enableSessionTelemetry: false,
        skipEmbeddingRetrieval: true,
        embeddingCacheStorage: "in-memory",
        infiniteSessions: { enabled: false },
        systemMessage: { mode: "replace", content: system },
        onPermissionRequest: () => ({ kind: "denied-by-rules", rules: [] }),
        hooks: { onErrorOccurred: () => ({ errorHandling: "abort", retryCount: 0 }) },
      });

      try {
        return await executeSdkCall(
          session,
          user,
          () => client.deleteSession(session.sessionId),
          signal,
        );
      } catch (error) {
        failed = true;
        throw error;
      }
    },
    isHealthy: () => !failed,
    close: cleanup,
  };
}

/**
 * Adapts the text-only SDK transport to Ax's public provider interface.
 *
 * @param transport - Isolated transport that performs exactly one SDK call per chat.
 * @param model - Pinned model ID; defaults to {@link DEFAULT_MODEL}.
 * @param systemPrefix - Optional trusted prefix for optimizer-internal typed programs.
 * @returns Ax AI service with tools, streaming, embeddings, and native schema mode disabled.
 */
export function copilotAI(transport: CopilotTransport, model = DEFAULT_MODEL, systemPrefix = ""): AxAIService {
  let options: AxAIServiceOptions = { stream: false, debug: false };
  const latencySamples: number[] = [];
  let errorCount = 0;
  let warnedAboutSampling = false;

  return {
    // Advertise only capabilities this minimal text-only adapter actually implements.
    getId: () => "taxonome-copilot-sdk",
    getName: () => "GitHub Copilot SDK",
    getModelList: () => undefined,
    getFeatures: () => ({
      functions: false,
      functionEmulation: false,
      streaming: false,
      structuredOutputs: false,
      caching: { supported: false, types: [] },
      thinking: false,
      multiTurn: true,
      media: {
        images: { supported: false, formats: [] },
        audio: { supported: false, formats: [] },
        files: { supported: false, formats: [], uploadMethod: "none" },
        urls: { supported: false, webSearch: false, contextFetching: false },
      },
    }),
    getMetrics: () => ({
      // Ax expects service-level latency/error metrics; token usage stays on each completion.
      latency: {
        chat: {
          mean: latencySamples.length ? latencySamples.reduce((total, sample) => total + sample, 0) / latencySamples.length : 0,
          p95: 0,
          p99: 0,
          samples: latencySamples,
        },
        embed: { mean: 0, p95: 0, p99: 0, samples: [] },
      },
      errors: {
        chat: {
          count: errorCount,
          rate: latencySamples.length ? errorCount / latencySamples.length : 0,
          total: latencySamples.length,
        },
        embed: { count: 0, rate: 0, total: 0 },
      },
    }),
    getLogger: () => () => { },
    getLastUsedChatModel: () => model,
    getLastUsedEmbedModel: () => undefined,
    getLastUsedModelConfig: () => ({}),
    getEstimatedCost: () => Number.NaN,
    setOptions: value => {
      options = value;
    },
    getOptions: () => options,
    embed: async () => {
      throw new Error("Embeddings are not supported");
    },
    transcribe: async () => {
      throw new Error("Transcription is not supported");
    },
    speak: async () => {
      throw new Error("Speech is not supported");
    },
    /**
     * Converts one Ax text chat into one SDK completion and normalized Ax usage.
     *
     * @param request - Ax text-chat request; tools/native schema/model overrides are rejected.
     * @param callOptions - Per-call Ax options, including optional cancellation.
     */
    async chat(request: Readonly<AxChatRequest>, callOptions?: Readonly<AxAIServiceOptions>): Promise<AxChatResponse> {
      // Reject unsupported features instead of silently degrading Ax's request.
      if (callOptions?.stream ?? options.stream) {
        throw new Error("Streaming is not supported by the text-only SDK adapter");
      }
      if (request.responseFormat) {
        throw new Error("Native structured output is not supported; use the Ax prompt/JSON parser and shared result validator");
      }
      if (request.model && request.model !== model) {
        throw new Error("This SDK adapter is pinned to its configured model");
      }

      if (request.modelConfig && Object.keys(request.modelConfig).length && !warnedAboutSampling) {
        warnedAboutSampling = true;
        process.stderr.write("taxonome: SDK-managed sampling; Ax temperature/token-limit hints cannot be applied by this SDK. Actual settings remain fixed low reasoning; see optimization manifest transport settings.\n");
      }
      if (request.functions?.length || request.chatPrompt.some(message => message.role === "function" || (message.role === "assistant" && message.functionCalls?.length))) {
        throw new Error("Taxonome's SDK provider does not allow tools");
      }
      const system: string[] = [];
      const messages: string[] = [];

      // Preserve roles in a text envelope while installing system messages through the SDK boundary.
      for (const message of request.chatPrompt) {
        if (message.role === "system") {
          system.push(message.content);
        } else {
          if (message.role === "function") {
            throw new Error("Only text messages are supported");
          }
          const content = axTextMessageContent(message.content);
          messages.push(`<${message.role}>\n${content}\n</${message.role}>`);
        }
      }

      const startedAt = Date.now();
      try {
        // Each Ax chat maps to exactly one transport completion. Ax alone may
        // request one additional chat for output validation correction.
        const result = await transport.complete(
          [systemPrefix, ...system].filter(Boolean).join("\n\n"),
          messages.join("\n\n"),
          callOptions?.abortSignal ?? options.abortSignal,
        );
        if (
          model !== "auto" &&
          typeof result.usage?.model === "string" &&
          result.usage.model !== model
        ) {
          throw new Error("SDK usage reports an unexpected model; no silent model substitution is allowed");
        }

        const inputTokens = result.usage?.inputTokens;
        const outputTokens = result.usage?.outputTokens;
        return {
          results: [{ index: 0, content: result.content, finishReason: "stop" }],
          ...(typeof inputTokens === "number" && typeof outputTokens === "number" ? {
            modelUsage: {
              ai: "GitHub Copilot SDK",
              model,
              tokens: {
                promptTokens: inputTokens,
                completionTokens: outputTokens,
                totalTokens: inputTokens + outputTokens
              },
            },
          } : {}),
        };
      } catch (error) {
        errorCount++;
        throw error;
      } finally {
        latencySamples.push(Date.now() - startedAt);
      }
    },
  };
}

/**
 * Creates the production executor that builds programs from loaded YAML.
 *
 * @param ai - Ax service backed by the isolated Copilot SDK.
 */
export function taxonomyPromptExecutor(
  ai: AxAIService,
): PromptExecutor {
  return {
    async evaluate(
      element,
      input: LoadedTaxonomyInput,
      signal?: AbortSignal,
    ): Promise<PromptExecutionResult> {
      let startedCompletions = 0;
      let completedCompletions = 0;
      let validatedCompletions = 0;
      let lastDiagnostics: ValidationDiagnostic[] = [];
      const observedChat: AxAIService["chat"] = async (
        request,
        options,
      ) => {
        startedCompletions++;
        const response = await ai.chat(request, options);
        completedCompletions++;
        return response;
      };
      const observedAI = new Proxy(ai, {
        get(target, property, receiver) {
          if (property === "chat") return observedChat;
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function"
            ? value.bind(target)
            : value;
        },
      });
      const program = createTaxonomyPromptProgram(
        element,
        {
          correctionRetries: 1,
          assertion: observation => {
            validatedCompletions++;
            const validation = validateParsedAssessment(
              observation,
              element.output,
              input.atif,
            );
            lastDiagnostics = validation.diagnostics;
            if (validation.assessment) return true;
            return `The parsed assessment is invalid. JSON property-name casing is significant. Use the exact canonical keys where applicable: ${ASSESSMENT_EXACT_KEYS.join(", ")}. Return one complete replacement assessment. Taxonome validation diagnostics: ${
              boundedErrorMessage(JSON.stringify(validation.diagnostics))
            }`;
          },
        },
      );
      try {
        const result = await program.forward(
          observedAI,
          { trajectory_context: taxonomyPromptEvidence(input) },
          {
            abortSignal: signal,
            maxRetries: 1,
            maxSteps: 1,
            stream: false,
          },
        );
        return {
          status: "succeeded",
          candidate: result.observation,
          attempts: successfulPromptAttempts(completedCompletions),
        };
      } catch (error) {
        const cancelled = Boolean(signal?.aborted);
        if (completedCompletions < startedCompletions) {
          return {
            status: "failed",
            attempts: interruptedPromptAttempts(
              startedCompletions,
              completedCompletions,
              cancelled,
            ),
            error: {
              code: cancelled ? "cancelled" : "execution_failed",
              message: cancelled
                ? "Prompt execution was cancelled."
                : boundedErrorMessage(error),
              ...(lastDiagnostics.length
                ? { validation_errors: lastDiagnostics }
                : {}),
            },
          };
        }
        if (
          completedCompletions > 0 &&
          (
            lastDiagnostics.length ||
            error instanceof AxGenerateError ||
            error instanceof AxAssertionError
          )
        ) {
          const diagnostics = validatedCompletions === completedCompletions &&
              lastDiagnostics.length
            ? lastDiagnostics
            : [invalidJsonDiagnostic()];
          return {
            status: "failed",
            attempts: invalidPromptAttempts(completedCompletions),
            error: {
              code: "invalid_output",
              message:
                "Ax output validation failed after the configured correction budget.",
              validation_errors: diagnostics,
            },
          };
        }
        throw error;
      }
    },
  };
}

function successfulPromptAttempts(
  completed: number,
): AttemptProvenance[] {
  return completed > 1
    ? [
      { attempt: 1, kind: "initial", outcome: "invalid_output" },
      { attempt: 2, kind: "repair", outcome: "succeeded" },
    ]
    : [{ attempt: 1, kind: "initial", outcome: "succeeded" }];
}

function invalidPromptAttempts(
  completed: number,
): AttemptProvenance[] {
  return completed > 1
    ? [
      { attempt: 1, kind: "initial", outcome: "invalid_output" },
      { attempt: 2, kind: "repair", outcome: "invalid_output" },
    ]
    : [{ attempt: 1, kind: "initial", outcome: "invalid_output" }];
}

function interruptedPromptAttempts(
  started: number,
  completed: number,
  cancelled: boolean,
): AttemptProvenance[] {
  const outcome = cancelled ? "cancelled" : "execution_failed";
  if (started > 1 && completed > 0) {
    return [
      { attempt: 1, kind: "initial", outcome: "invalid_output" },
      { attempt: 2, kind: "repair", outcome },
    ];
  }
  return [{ attempt: 1, kind: "initial", outcome }];
}

function invalidJsonDiagnostic(): ValidationDiagnostic {
  return {
    code: "invalid_json",
    output_path: "$.observation",
    message: "Ax could not parse the observation field as one JSON value.",
  };
}
