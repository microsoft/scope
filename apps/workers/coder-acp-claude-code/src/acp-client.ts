// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * ACP Client for Claude Code
 * 
 * This module provides functionality to communicate with Claude Code
 * via the Agent Client Protocol (ACP) using stdio communication.
 */

import { spawn, ChildProcess } from "node:child_process";
import { Duplex } from "node:stream";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve, isAbsolute } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type { McpServerConfig } from "shared";

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
  /** Reasoning effort level to apply via ACP config option (e.g. "low", "medium", "high"). */
  reasoningEffort?: string;
  /** Host-only isolation keeps HOME for login reuse while suppressing personal Claude settings/MCP config for reproducible benchmarks. */
  isolateHostConfig?: boolean;
}

export interface ACPSessionResult {
  response: string;
  stopReason: string;
}

export type ClaudeCodeIsolationMeta = {
  [key: string]: unknown;
  claudeCode: {
    options: {
      settingSources: [];
      extraArgs: ["--strict-mcp-config"];
    };
  };
};

/**
 * Build the Claude Code ACP adapter metadata that isolates host runs from
 * personal settings and MCP files without relocating HOME/CLAUDE_CONFIG_DIR,
 * preserving the installed CLI login that host workers intentionally reuse.
 */
export function buildClaudeCodeIsolationMeta(): ClaudeCodeIsolationMeta {
  return {
    claudeCode: {
      options: {
        settingSources: [],
        extraArgs: ["--strict-mcp-config"],
      },
    },
  };
}

function toAcpMcpServer(server: McpServerConfig): acp.McpServer {
  if (server.type === "stdio") {
    if (!server.command) {
      throw new Error(`MCP server "${server.name}" is missing a command`);
    }
    return {
      name: server.name,
      command: server.command,
      args: server.args ?? [],
      env: server.env ? Object.entries(server.env).map(([name, value]) => ({ name, value })) : [],
    };
  }

  if (!server.url) {
    throw new Error(`MCP server "${server.name}" is missing a URL`);
  }
  return {
    type: server.type,
    name: server.name,
    url: server.url,
    headers: server.headers?.map((h) => ({ name: h.name, value: h.value })) ?? [],
  };
}

/**
 * Build the ACP session/new request, optionally adding Claude Code host
 * isolation metadata so benchmark behavior does not depend on personal agent
 * configuration.
 */
export function buildClaudeCodeNewSessionRequest(
  cwd: string,
  mcpServers: McpServerConfig[],
  isolateHostConfig = false,
): acp.NewSessionRequest {
  return {
    ...(isolateHostConfig ? { _meta: buildClaudeCodeIsolationMeta() } : {}),
    cwd,
    mcpServers: mcpServers.map(toAcpMcpServer),
  };
}

/**
 * ACP Client implementation that handles permission requests and session updates
 */
export class ACPClientHandler implements acp.Client {
  private responseChunks: string[] = [];
  private onLog: (message: string) => void;
  private workspacePath: string;
  /** Maps a tool call id to its title and kind so updates can show the
   * human-readable title (instead of the opaque upstream id, e.g.
   * `toolu_bdrk_...`) and carry the kind forward when an update omits it. */
  private toolCalls = new Map<string, { title?: string; kind?: string }>();

  constructor(onLog: (message: string) => void, workspacePath: string) {
    this.onLog = onLog;
    this.workspacePath = workspacePath;
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

  private resolvePath(filePath: string): string {
    const fullPath = isAbsolute(filePath)
      ? resolve(filePath)
      : resolve(this.workspacePath, filePath);
    if (!fullPath.startsWith(this.workspacePath + "/") && fullPath !== this.workspacePath) {
      throw new Error(
        `Path traversal blocked: "${filePath}" resolves outside workspace "${this.workspacePath}"`
      );
    }
    return fullPath;
  }

  async writeTextFile(
    params: acp.WriteTextFileRequest
  ): Promise<acp.WriteTextFileResponse> {
    const fullPath = this.resolvePath(params.path);
    this.onLog(`Write file: ${params.path} (${params.content.length} chars)`);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, params.content, "utf-8");
    return {};
  }

  async readTextFile(
    params: acp.ReadTextFileRequest
  ): Promise<acp.ReadTextFileResponse> {
    const fullPath = this.resolvePath(params.path);
    this.onLog(`Read file: ${params.path}`);
    try {
      const content = readFileSync(fullPath, "utf-8");
      return { content };
    } catch {
      return { content: "" };
    }
  }
}

/**
 * Attempt to set the reasoning effort level via ACP session/set_config_option.
 *
 * Looks for a config option with `category: "thought_level"` (the category Claude Code
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

  // Look for a config option with category "thought_level"
  const effortConfigOption = sessionResult.configOptions.find(
    (o) => o.category === "thought_level"
  );
  if (!effortConfigOption) {
    onLog(`Warning: agent does not advertise a "thought_level" config option; reasoning effort "${reasoningEffort}" may not be honoured. Available config options: ${sessionResult.configOptions.map((o) => `${o.id} (category: ${o.category ?? "none"})`).join(", ")}`);
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
 * Run an ACP session with Claude Code
 */
export async function runACPSession(
  prompt: string,
  options: ACPClientOptions
): Promise<ACPSessionResult> {
  const { command, args = [], env = {}, cwd, onLog = console.log, mcpServers = [], reasoningEffort, isolateHostConfig = false } = options;

  onLog(`Starting ACP agent: ${command} ${args.join(" ")}`);

  // Spawn the agent process
  const agentProcess: ChildProcess = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (!agentProcess.stdin || !agentProcess.stdout) {
    throw new Error("Failed to create agent process streams");
  }

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

  const clientHandler = new ACPClientHandler(onLog, cwd);
  const connection = new acp.ClientSideConnection(
    (_agent) => clientHandler,
    acpStream
  );

  try {
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

    // Skip authentication for Claude Code - it uses ANTHROPIC_API_KEY env var
    // The agent reports auth methods but doesn't implement the authenticate RPC
    if (initResult.authMethods && initResult.authMethods.length > 0) {
      onLog(`Auth methods available: ${initResult.authMethods.map((m: { name: string }) => m.name).join(', ')} (skipping - using API key)`);
    }

    // Create a new session
    if (mcpServers.length > 0) {
      onLog(`Configuring ${mcpServers.length} MCP server(s): ${mcpServers.map((s) => `${s.name} (${s.type})`).join(", ")}`);
    } else {
      onLog(`No MCP servers configured for this session`);
    }
    const sessionResult = await connection.newSession(buildClaudeCodeNewSessionRequest(cwd, mcpServers, isolateHostConfig));

    onLog(`Created session: ${sessionResult.sessionId}`);
    if (sessionResult._meta) {
      onLog(`Session meta: ${JSON.stringify(sessionResult._meta)}`);
    }
    if (sessionResult.configOptions) {
      onLog(`Session config options: ${sessionResult.configOptions.map((o: { configId?: string; id?: string; category?: string }) => `${o.id ?? o.configId}${o.category ? ` (${o.category})` : ""}`).join(", ")}`);
    }

    // Set reasoning effort if requested
    if (reasoningEffort) {
      await selectReasoningEffort(connection, sessionResult, reasoningEffort, onLog);
    }

    // Set permission mode to bypass all permission checks (yolo mode).
    // The ACP client already auto-approves everything, so this eliminates
    // the unnecessary permission request roundtrips.
    const availableModes = sessionResult.modes?.availableModes?.map((m: { id: string }) => m.id) ?? [];
    if (availableModes.includes("bypassPermissions")) {
      await connection.setSessionMode({
        sessionId: sessionResult.sessionId,
        modeId: "bypassPermissions",
      });
      onLog(`Set session mode to bypassPermissions`);
    } else {
      onLog(`bypassPermissions mode not available (available: ${availableModes.join(", ")})`);
    }

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
    };
  } catch (error) {
    // Better error serialization
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(JSON.stringify(error, null, 2));
  } finally {
    // Cleanup
    stdinStream.end();
    agentProcess.kill();
  }
}
