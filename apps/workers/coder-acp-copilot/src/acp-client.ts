// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * ACP Client for Copilot CLI
 *
 * This module provides functionality to communicate with the Copilot CLI
 * via the Agent Client Protocol (ACP) using stdio communication.
 */

import { spawn, ChildProcess } from "node:child_process";
import * as acp from "@agentclientprotocol/sdk";
import type { McpServerConfig } from "shared";

/** Default ACP session timeout: 60 minutes */
const DEFAULT_SESSION_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Argument keys whose values are redacted in log previews to avoid leaking
 * secrets (API keys, tokens, passwords) into logs that are streamed via SSE
 * and persisted to MongoDB/Blob storage. Matched case-insensitively as a
 * substring of the key name.
 */
const SENSITIVE_KEY_PATTERN =
  /token|secret|password|passwd|authorization|credential|api[-_]?key|key/i;

/**
 * File paths whose diff contents are redacted, since their text is typically
 * secret material rather than source code (e.g. `.env`, private keys/certs).
 */
const SENSITIVE_PATH_PATTERN = /(^|\/)\.env|secret|credential|\.pem$|\.key$/i;

const REDACTED = "[redacted]";

/**
 * Truncate a string to at most `maxLength` characters, appending an ellipsis
 * when truncated.
 */
function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

/**
 * Build a short, human-readable preview of a tool call's raw input arguments
 * for logging (e.g. `command=npm create astro, path=src`). Whitespace is
 * collapsed and the result is truncated. Values of sensitive keys (tokens,
 * passwords, etc.) are redacted. Returns an empty string when there is nothing
 * useful to show.
 */
export function formatToolArgs(rawInput: unknown, maxLength = 160): string {
  if (rawInput === null || typeof rawInput !== "object") {
    return "";
  }
  const entries = Object.entries(rawInput as Record<string, unknown>);
  if (entries.length === 0) {
    return "";
  }
  const formatted = entries
    .map(([key, value]) => {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        return `${key}=${REDACTED}`;
      }
      let rendered: string;
      if (typeof value === "string") {
        rendered = value;
      } else {
        try {
          rendered = JSON.stringify(value) ?? String(value);
        } catch {
          rendered = String(value);
        }
      }
      rendered = rendered.replace(/\s+/g, " ").trim();
      return `${key}=${rendered}`;
    })
    .join(", ");
  return truncate(formatted, maxLength);
}

/**
 * Build a short, human-readable preview of a tool call's `content` array for
 * logging. Handles the three ACP `ToolCallContent` variants:
 * - `diff`    -> `diff <path> <newText preview>` (text redacted for secret paths)
 * - `terminal`-> `terminal <terminalId>`
 * - `content` -> the text block, or `[image]`/`[audio]`/`[resource]` for non-text
 * Whitespace is collapsed and the result is truncated. Returns an empty string
 * when there is nothing useful to show.
 */
export function formatToolContent(content: unknown, maxLength = 160): string {
  if (!Array.isArray(content) || content.length === 0) {
    return "";
  }
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    if (c.type === "diff") {
      const path = typeof c.path === "string" ? c.path : "";
      const newText = typeof c.newText === "string" ? c.newText : "";
      const body = path && SENSITIVE_PATH_PATTERN.test(path) ? REDACTED : newText;
      parts.push(["diff", path, body].filter(Boolean).join(" "));
    } else if (c.type === "terminal") {
      const terminalId = typeof c.terminalId === "string" ? c.terminalId : "";
      parts.push(["terminal", terminalId].filter(Boolean).join(" "));
    } else if (c.type === "content") {
      const block = c.content as Record<string, unknown> | undefined;
      if (block?.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      } else if (typeof block?.type === "string") {
        parts.push(`[${block.type}]`);
      }
    }
  }
  const formatted = parts.join(" ").replace(/\s+/g, " ").trim();
  if (!formatted) {
    return "";
  }
  return truncate(formatted, maxLength);
}

export interface ACPClientOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd: string;
  onLog?: (message: string) => void;
  mcpServers?: McpServerConfig[];
  /** Session timeout in milliseconds (default: 30 min). Set to 0 to disable. */
  sessionTimeoutMs?: number;
  /**
   * Model to select after the session is created, or a selector resolved from
   * the new session response for session-scoped policies and integration probes.
   */
  model?: string | ACPModelSelector;
  /** Reasoning effort level to apply via ACP config option (e.g. "low", "medium", "high"). */
  reasoningEffort?: string;
  /** Use shell to spawn the process (required on Windows for .cmd shim resolution). */
  shell?: boolean;
}

export interface ACPSessionResult {
  response: string;
  stopReason: string;
  /** Model active when the ACP session was created, when advertised by the agent. */
  initialModel?: string;
  /** Model successfully activated through ACP, or undefined if selection was not requested or did not succeed. */
  confirmedModel?: string;
}

/**
 * Select a model after ACP session creation, when session-scoped model
 * capabilities are available.
 */
export type ACPModelSelector = (
  sessionResult: acp.NewSessionResponse
) => string | undefined;

export function resolveRequestedModel(
  model: string | ACPModelSelector | undefined,
  sessionResult: acp.NewSessionResponse
): string | undefined {
  return typeof model === "function" ? model(sessionResult) : model;
}

export function getCurrentModelId(
  sessionResult: acp.NewSessionResponse
): string | undefined {
  return (
    sessionResult.models?.currentModelId ??
    getModelConfigOption(sessionResult)?.currentValue
  );
}

function getModelConfigOption(
  sessionResult: acp.NewSessionResponse
): acp.SessionConfigOption | undefined {
  return sessionResult.configOptions?.find(
    (option: acp.SessionConfigOption) => option.category === "model"
  );
}

function getConfigOptionValues(
  configOption: acp.SessionConfigOption
): string[] {
  return configOption.options.flatMap((option) =>
    "value" in option
      ? [option.value]
      : option.options.map((groupedOption) => groupedOption.value)
  );
}

export function hasModelSelectionCapability(
  sessionResult: acp.NewSessionResponse
): boolean {
  return (
    sessionResult.models != null ||
    getModelConfigOption(sessionResult) !== undefined
  );
}

/**
 * Choose the first advertised model that differs from the session default.
 *
 * Intended for integration coverage that must exercise model switching without
 * depending on a server-controlled model id.
 */
export function selectFirstAvailableNonDefaultModel(
  sessionResult: acp.NewSessionResponse
): string | undefined {
  const models = sessionResult.models;
  if (models) {
    return models.availableModels.find(
      (candidate) => candidate.modelId !== models.currentModelId
    )?.modelId;
  }

  const modelConfigOption = getModelConfigOption(sessionResult);
  if (!modelConfigOption) {
    return undefined;
  }

  return getConfigOptionValues(modelConfigOption).find(
    (value) => value !== modelConfigOption.currentValue
  );
}

/**
 * ACP Client implementation that handles permission requests and session updates
 */
class ACPClientHandler implements acp.Client {
  private responseChunks: string[] = [];
  private onLog: (message: string) => void;
  /** Maps a tool call id to its title and kind so updates can show the
   * human-readable title (instead of the opaque upstream id, e.g.
   * `toolu_bdrk_...`) and carry the kind forward when an update omits it. */
  private toolCalls = new Map<string, { title?: string; kind?: string }>();

  constructor(onLog: (message: string) => void) {
    this.onLog = onLog;
  }

  getResponse(): string {
    return this.responseChunks.join("");
  }

  async requestPermission(
    params: acp.RequestPermissionRequest
  ): Promise<acp.RequestPermissionResponse> {
    this.onLog(`Permission requested: ${params.toolCall.title}`);
    
    // Auto-approve all permissions for automated processing
    const firstOption = params.options[0];
    if (firstOption) {
      return {
        outcome: {
          outcome: "selected",
          optionId: firstOption.optionId,
        },
      };
    }
    
    // Fallback: cancel if no options
    return {
      outcome: {
        outcome: "cancelled",
      },
    };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update;

    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") {
          this.responseChunks.push(update.content.text);
        }
        break;
      case "agent_thought_chunk":
        if (update.content.type === "text") {
          this.onLog(`[Thinking] ${update.content.text.substring(0, 100)}...`);
        }
        break;
      case "tool_call": {
        this.toolCalls.set(update.toolCallId, {
          title: update.title,
          kind: update.kind,
        });
        const args =
          formatToolArgs(update.rawInput) || formatToolContent(update.content);
        const parts = ["Tool call:"];
        if (update.kind) parts.push(`[${update.kind}]`);
        parts.push(update.title);
        if (args) parts.push(args);
        if (update.status) parts.push(`(${update.status})`);
        this.onLog(parts.join(" "));
        break;
      }
      case "tool_call_update": {
        const cached = this.toolCalls.get(update.toolCallId);
        const kind = update.kind ?? cached?.kind;
        const label = cached?.title ?? update.toolCallId;
        const args =
          formatToolArgs(update.rawInput) || formatToolContent(update.content);
        const parts = ["Tool update:"];
        if (kind) parts.push(`[${kind}]`);
        parts.push(label);
        if (args) parts.push(args);
        if (update.status) parts.push(`- ${update.status}`);
        this.onLog(parts.join(" "));
        // Drop the cached title/kind once the call reaches a terminal state so
        // the map doesn't retain every tool id for the life of the session.
        if (update.status === "completed" || update.status === "failed") {
          this.toolCalls.delete(update.toolCallId);
        }
        break;
      }
      default:
        break;
    }
  }

  async writeTextFile(
    params: acp.WriteTextFileRequest
  ): Promise<acp.WriteTextFileResponse> {
    this.onLog(`Write file: ${params.path}`);
    return {};
  }

  async readTextFile(
    params: acp.ReadTextFileRequest
  ): Promise<acp.ReadTextFileResponse> {
    this.onLog(`Read file: ${params.path}`);
    return {
      content: "",
    };
  }
}

/**
 * Attempt to select the requested model via ACP after a session is created.
 *
 * Tries two mechanisms in order of preference:
 * 1. `unstable_setSessionModel` — if the session response includes a `models` field
 * 2. `session/set_config_option` — if a config option with `category: "model"` exists
 *
 * Logs a warning if the requested model is not in the available list.
 * Logs a warning and proceeds without error if neither mechanism is available.
 */
export async function selectModel(
  connection: acp.ClientSideConnection,
  sessionResult: acp.NewSessionResponse,
  model: string,
  onLog: (message: string) => void
): Promise<string | undefined> {
  // Path 1: unstable session/set_model (models field in newSession response)
  if (sessionResult.models) {
    const available = sessionResult.models.availableModels.map(
      (m: { modelId: string; name: string }) => m.modelId
    );
    if (!available.includes(model)) {
      onLog(`Warning: requested model "${model}" not in available models [${available.join(", ")}] — attempting anyway`);
    }
    try {
      await connection.unstable_setSessionModel({
        sessionId: sessionResult.sessionId,
        modelId: model,
      });
      onLog(`Model set to "${model}" via session/set_model`);
      return model;
    } catch (err) {
      onLog(`Warning: session/set_model failed for "${model}": ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  // Path 2: stable session/set_config_option with category "model"
  const modelConfigOption = getModelConfigOption(sessionResult);
  if (modelConfigOption) {
    try {
      await connection.setSessionConfigOption({
        sessionId: sessionResult.sessionId,
        configId: modelConfigOption.id,
        value: model,
      });
      onLog(`Model set to "${model}" via session/set_config_option (configId: ${modelConfigOption.id})`);
      return model;
    } catch (err) {
      onLog(`Warning: session/set_config_option failed for model "${model}": ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  // Neither mechanism available — warn and continue
  if (!hasModelSelectionCapability(sessionResult)) {
    onLog(`Warning: agent does not advertise model selection capability (no models field or model config option); model "${model}" may not be honoured`);
  }
  return undefined;
}

/**
 * Attempt to set the reasoning effort level via ACP session/set_config_option.
 *
 * Looks for a config option with `category: "thought_level"` (the category Copilot CLI
 * uses for reasoning effort). If none is found, logs a warning and continues.
 */
export async function selectReasoningEffort(
  connection: acp.ClientSideConnection,
  sessionResult: acp.NewSessionResponse,
  reasoningEffort: string,
  onLog: (message: string) => void
): Promise<string | undefined> {
  if (!sessionResult.configOptions) {
    onLog(`Warning: agent does not advertise config options; reasoning effort "${reasoningEffort}" may not be honoured`);
    return undefined;
  }

  // Look for a config option with category "thought_level" (Copilot CLI's reasoning effort category)
  const effortConfigOption = sessionResult.configOptions.find(
    (o) => o.category === "thought_level"
  );
  if (!effortConfigOption) {
    onLog(`Warning: agent does not advertise a "thought_level" config option; reasoning effort "${reasoningEffort}" may not be honoured`);
    return undefined;
  }

  try {
    await connection.setSessionConfigOption({
      sessionId: sessionResult.sessionId,
      configId: effortConfigOption.id,
      value: reasoningEffort,
    });
    onLog(`Reasoning effort set to "${reasoningEffort}" via session/set_config_option (configId: ${effortConfigOption.id})`);
    return reasoningEffort;
  } catch (err) {
    onLog(`Warning: session/set_config_option failed for reasoning effort "${reasoningEffort}": ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * Canonical ACP session-mode id for the Copilot CLI's autopilot mode.
 *
 * The CLI advertises session modes by their well-known ACP URL ids (e.g.
 * `https://agentclientprotocol.com/protocol/session-modes#agent`), not bare
 * names. Autopilot is the only mode that enables allow-all and runs commands
 * (build/test) without interactive permission prompts.
 */
export const AUTOPILOT_MODE_ID =
  "https://agentclientprotocol.com/protocol/session-modes#autopilot";

/**
 * Switch the ACP session into autopilot mode so the agent can execute commands
 * (e.g. `npm run build`) headlessly without interactive permission prompts.
 *
 * The default session mode is `agent`, in which execute/bash tool calls are
 * denied non-interactively — the `--yolo` CLI flag does not change the ACP
 * session mode. We therefore explicitly set the mode to autopilot, matching by
 * its canonical URL id (with an `endsWith("#autopilot")` safety net). If no
 * autopilot mode is advertised, we log a warning and continue.
 */
export async function selectPermissionMode(
  connection: acp.ClientSideConnection,
  sessionResult: acp.NewSessionResponse,
  onLog: (message: string) => void
): Promise<void> {
  const availableModes = sessionResult.modes?.availableModes ?? [];
  const availableIds = availableModes.map((m: { id: string }) => m.id);

  const autopilotMode =
    availableModes.find((m: { id: string }) => m.id === AUTOPILOT_MODE_ID) ??
    availableModes.find((m: { id: string }) => m.id.endsWith("#autopilot"));

  if (!autopilotMode) {
    onLog(`Warning: autopilot mode not available (available: [${availableIds.join(", ")}]) — commands may be denied`);
    return;
  }

  // The very first set_mode immediately after session creation can fail with a
  // transient error (cold start: the CLI process is not yet ready to accept the
  // request). Retry once before giving up so a single race does not silently
  // leave the session in `agent` mode where commands are denied.
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await connection.setSessionMode({
        sessionId: sessionResult.sessionId,
        modeId: autopilotMode.id,
      });
      onLog(`Set session mode to autopilot (${autopilotMode.id})`);
      return;
    } catch (err) {
      const detail = formatModeError(err);
      if (attempt < maxAttempts) {
        onLog(`Warning: failed to set autopilot session mode (attempt ${attempt}/${maxAttempts}): ${detail} — retrying`);
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      onLog(`Warning: failed to set autopilot session mode after ${maxAttempts} attempts: ${detail}`);
    }
  }
}

/**
 * Serialize an unknown rejection into a human-readable string. ACP/JSON-RPC
 * rejections are plain objects (e.g. `{ code, message, data }`), not `Error`
 * instances, so `String(err)` yields an unhelpful `[object Object]`. Prefer the
 * `message`, then a JSON dump, and fall back to `String` only as a last resort.
 */
export function formatModeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const maybeMessage = (err as { message?: unknown }).message;
    if (typeof maybeMessage === "string" && maybeMessage.length > 0) {
      const code = (err as { code?: unknown }).code;
      return code !== undefined ? `${maybeMessage} (code ${String(code)})` : maybeMessage;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

/**
 * Run an ACP session with the Copilot CLI (or any ACP-compatible agent).
 */
export async function runACPSession(
  prompt: string,
  options: ACPClientOptions
): Promise<ACPSessionResult> {
  const { command, args = [], env = {}, cwd, onLog = console.log, mcpServers = [], model, reasoningEffort, shell = false } = options;
  const sessionTimeoutMs = options.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;

  onLog(`Starting ACP agent: ${command} ${args.join(" ")}`);

  // Spawn the agent process
  const agentProcess: ChildProcess = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    shell,
  });

  if (!agentProcess.stdin || !agentProcess.stdout) {
    throw new Error("Failed to create agent process streams");
  }

  // Track whether the ACP session has completed (to avoid spurious exit errors)
  let sessionCompleted = false;

  // Create a promise that rejects when the subprocess exits unexpectedly
  const exitPromise = new Promise<never>((_, reject) => {
    agentProcess.on("exit", (code, signal) => {
      if (!sessionCompleted) {
        const reason = signal ? `signal ${signal}` : `code ${code}`;
        reject(new Error(`ACP agent process exited unexpectedly (${reason})`));
      }
    });
    agentProcess.on("error", (err) => {
      if (!sessionCompleted) {
        reject(new Error(`ACP agent process failed to start: ${err.message}`));
      }
    });
  });

  // Create duplex stream for ACP communication
  const stdinStream = agentProcess.stdin;
  const stdoutStream = agentProcess.stdout;

  // Log stderr for debugging
  agentProcess.stderr?.on("data", (chunk: Buffer) => {
    onLog(`[stderr] ${chunk.toString().trim()}`);
  });

  // Create ACP stream
  const acpStream = acp.ndJsonStream(
    new WritableStream({
      write(chunk) {
        stdinStream.write(chunk);
      },
    }),
    new ReadableStream({
      start(controller) {
        stdoutStream.on("data", (chunk: Buffer) => {
          controller.enqueue(chunk);
        });
        stdoutStream.on("end", () => controller.close());
        stdoutStream.on("error", (err) => controller.error(err));
      },
    })
  );

  const clientHandler = new ACPClientHandler(onLog);
  const connection = new acp.ClientSideConnection(
    (_agent) => clientHandler,
    acpStream
  );

  try {
    // Build the actual ACP session work as a promise
    const sessionWork = async (): Promise<ACPSessionResult> => {
    // Initialize the connection
    const initResult = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
      },
    });

    onLog(`Connected to agent (protocol v${initResult.protocolVersion})`);

    // Authenticate if needed
    if (initResult.authMethods && initResult.authMethods.length > 0) {
      const authMethod = initResult.authMethods[0];
      onLog(`Authenticating with method: ${authMethod.name}`);
      await connection.authenticate({ methodId: authMethod.id });
      onLog(`Authenticated`);
    }

    // Create a new session
    if (mcpServers.length > 0) {
      onLog(`Configuring ${mcpServers.length} MCP server(s) via ACP session: ${mcpServers.map((s) => `${s.name} (${s.type})`).join(", ")}`);
    }
    const sessionResult = await connection.newSession({
      cwd,
      mcpServers: mcpServers.map((s) => ({
        type: s.type,
        name: s.name,
        url: s.url,
        headers: s.headers?.map((h) => ({ name: h.name, value: h.value })) ?? [],
      })),
    });

    onLog(`Created session: ${sessionResult.sessionId}`);
    if (sessionResult._meta) {
      onLog(`Session meta: ${JSON.stringify(sessionResult._meta)}`);
    }

    // Log the model state advertised by the agent
    if (sessionResult.models) {
      const availableModelIds = sessionResult.models.availableModels.map((m: { modelId: string; name: string }) => m.modelId);
      onLog(`Session models: current=${sessionResult.models.currentModelId}, available=[${availableModelIds.join(", ")}]`);
    }
    if (sessionResult.configOptions) {
      onLog(`Session config options: ${sessionResult.configOptions.map((o: acp.SessionConfigOption) => `${o.id}${o.category ? ` (${o.category})` : ""}`).join(", ")}`);
    }

    // Select model if requested. A selector is resolved only after newSession
    // because the current and available models are session-scoped.
    const initialModel = getCurrentModelId(sessionResult);
    let confirmedModel: string | undefined;
    const requestedModel = resolveRequestedModel(model, sessionResult);
    if (requestedModel) {
      confirmedModel = await selectModel(
        connection,
        sessionResult,
        requestedModel,
        onLog
      );
    } else if (typeof model === "function") {
      if (hasModelSelectionCapability(sessionResult)) {
        onLog(
          "Warning: model selector did not choose a model from the advertised model options"
        );
      } else {
        onLog(
          "Warning: agent does not advertise model selection capability (no models field or model config option)"
        );
      }
    }

    // Set reasoning effort if requested
    if (reasoningEffort) {
      await selectReasoningEffort(connection, sessionResult, reasoningEffort, onLog);
    }

    // Set the session into autopilot mode so the agent can execute commands
    // (build/test) headlessly. The default `agent` mode denies execute/bash
    // tool calls non-interactively, and the `--yolo` CLI flag does not change
    // the ACP session mode. The ACP client also auto-approves any residual
    // permission requests.
    await selectPermissionMode(connection, sessionResult, onLog);

    // Send prompt
    onLog(`Sending prompt...`);
    const promptResult = await connection.prompt({
      sessionId: sessionResult.sessionId,
      prompt: [
        {
          type: "text",
          text: prompt,
        },
      ],
    });

    onLog(`Agent completed with: ${promptResult.stopReason}`);

    return {
      response: clientHandler.getResponse(),
      stopReason: promptResult.stopReason,
      initialModel,
      confirmedModel,
    };
    };

    // Race the session work against subprocess exit and optional timeout
    const racers: Promise<ACPSessionResult>[] = [sessionWork(), exitPromise];

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (sessionTimeoutMs > 0) {
      racers.push(new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`ACP session timed out after ${sessionTimeoutMs}ms`));
        }, sessionTimeoutMs);
      }));
    }

    const result = await Promise.race(racers);
    sessionCompleted = true;
    if (timeoutId) clearTimeout(timeoutId);
    return result;
  } catch (error) {
    // Better error serialization
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(JSON.stringify(error, null, 2));
  } finally {
    sessionCompleted = true;
    // Cleanup
    stdinStream.end();
    agentProcess.kill();
  }
}
