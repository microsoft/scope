// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotClient } from "@github/copilot-sdk";
import type {
  AxAIService,
  AxAIServiceOptions,
  AxChatRequest,
  AxChatResponse,
  AxSerializedOptimizedProgram,
} from "@ax-llm/ax";
import type { PromptExecutor } from "./engine.js";
import { CallLedger } from "./ledger.js";
import {
  createTaxonomyPromptProgram,
  taxonomyPromptEvidence,
} from "./prompt.js";
import { executeSdkCall } from "./sdk-call.js";
import type { TaxonomyInput as LoadedTaxonomyInput } from "./scope-atif.js";

export { CallLedger } from "./ledger.js";
export {
  createTaxonomyPromptProgram,
  taxonomyPromptEvidence,
} from "./prompt.js";
export const DEFAULT_MODEL = "gpt-5.6-sol-fast";

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

/**
 * Opens an isolated, tool-free SDK client using only the explicit environment token.
 * The caller owns close(); a failed submission blocks further calls until reconciliation.
 *
 * @param ledger - Initialized shared ledger that gates every completion.
 * @param model - Exact model ID used for session creation and usage verification.
 * @param purpose - Stable ledger label attached to every completion.
 * @returns Text-only transport. Callers must invoke `close`.
 */
export async function openCopilotTransport(
  ledger: CallLedger,
  model: string,
  purpose: string,
): Promise<CopilotTransport> {
  const token = process.env.COPILOT_GITHUB_TOKEN;
  if (!token) {
    throw new Error("COPILOT_GITHUB_TOKEN is required for prompt execution (no logged-in-user fallback)");
  }

  await ledger.events();
  const sessionDirectory = await mkdtemp(join(tmpdir(), "taxonome-sdk-"));
  const client = new CopilotClient({
    mode: "empty",
    gitHubToken: token,
    useLoggedInUser: false,
    baseDirectory: sessionDirectory,
    workingDirectory: sessionDirectory,
    logLevel: "error",
    env: { PATH: process.env.PATH, HOME: sessionDirectory, TMPDIR: process.env.TMPDIR },
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
      throw new Error("Copilot SDK token authentication failed");
    }
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
     * Creates one isolated tool-free session and delegates guarded submission/accounting.
     *
     * @param system - Trusted system prompt installed with replace semantics.
     * @param user - Model-visible Ax text envelope.
     * @param signal - Optional caller cancellation signal.
     */
    async complete(system, user, signal) {
      if (failed) {
        throw new Error("Previous SDK call failed; reconcile the ledger before another live invocation");
      }

      const session = await client.createSession({
        // Empty mode plus explicit denials prevents ambient tools, instructions, skills, and storage.
        model,
        reasoningEffort: "low",
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
        return await executeSdkCall(session, ledger, model, purpose, user, () => client.deleteSession(session.sessionId), signal);
      } catch (error) {
        failed = true;
        throw error;
      }
    },
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
      // Ax expects service-level metrics; authoritative per-call usage remains in the durable SDK ledger.
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
        throw new Error("Streaming is not supported by the one-call SDK adapter");
      }
      if (request.responseFormat) {
        throw new Error("Native structured output is not supported; use the Ax prompt/JSON parser and shared result validator");
      }
      if (request.model && request.model !== model) {
        throw new Error("This SDK adapter is pinned to its configured model");
      }

      if (request.modelConfig && Object.keys(request.modelConfig).length && !warnedAboutSampling) {
        warnedAboutSampling = true;
        process.stderr.write("taxonome: SDK-managed sampling; Ax temperature/token-limit hints cannot be applied by this SDK. Actual settings remain fixed low reasoning; see artifact transport settings.\n");
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
          if (message.role === "function" || typeof message.content !== "string") {
            throw new Error("Only text messages are supported");
          }
          messages.push(`<${message.role}>\n${message.content}\n</${message.role}>`);
        }
      }

      const startedAt = Date.now();
      try {
        // Each Ax chat maps to exactly one transport completion; Ax retries are disabled by the program.
        const result = await transport.complete(
          [systemPrefix, ...system].filter(Boolean).join("\n\n"),
          messages.join("\n\n"),
          callOptions?.abortSignal ?? options.abortSignal,
        );
        if (typeof result.usage?.model === "string" && result.usage.model !== model) {
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
 * Restores optional learned components once and executes only the registered prompt element.
 *
 * @param ai - Ax service backed by the Copilot SDK transport.
 * @param artifact - Optional complete serialized optimized program.
 * @returns Prompt executor restricted to Skipped Invocation.
 */
/**
 * Creates the production executor that builds programs from loaded YAML.
 *
 * @param ai - Ax service backed by the isolated Copilot SDK.
 * @param artifacts - Optional compatible artifact by element ID.
 */
export function taxonomyPromptExecutor(
  ai: AxAIService,
  artifacts: ReadonlyMap<string, AxSerializedOptimizedProgram> = new Map(),
): PromptExecutor {
  const programs = new Map<string, ReturnType<typeof createTaxonomyPromptProgram>>();
  return {
    async evaluate(element, input: LoadedTaxonomyInput) {
      let program = programs.get(element.id);
      if (!program) {
        program = createTaxonomyPromptProgram(element, artifacts.get(element.id));
        programs.set(element.id, program);
      }
      const result = await program.forward(ai, {
        evidence: taxonomyPromptEvidence(input),
      }, {
        maxRetries: 0,
        maxSteps: 1,
        stream: false,
      });
      return result.observation;
    },
  };
}
