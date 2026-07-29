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
import type { McpServerConfig } from "@scope/core";

/** Default ACP session timeout: 30 minutes */
const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000;

export interface ACPClientOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd: string;
  onLog?: (message: string) => void;
  mcpServers?: McpServerConfig[];
  /** Session timeout in milliseconds (default: 30 min). Set to 0 to disable. */
  sessionTimeoutMs?: number;
  /** Model to select after the session is created (e.g. "gpt-5.4"). */
  model?: string;
  /** Use shell to spawn the process (required on Windows for .cmd shim resolution). */
  shell?: boolean;
}

export interface ACPSessionResult {
  response: string;
  stopReason: string;
  /** Model that was successfully activated via ACP set_model, or undefined if model selection was not requested or did not succeed. */
  confirmedModel?: string;
}

/**
 * ACP Client implementation that handles permission requests and session updates
 */
class ACPClientHandler implements acp.Client {
  private responseChunks: string[] = [];
  private onLog: (message: string) => void;

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
      case "tool_call":
        this.onLog(`Tool call: ${update.title} (${update.status})${update.kind ? ` [${update.kind}]` : ""}`);
        break;
      case "tool_call_update":
        this.onLog(`Tool update: ${update.toolCallId} - ${update.status}${update.kind ? ` [${update.kind}]` : ""}`);
        break;
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
  if (sessionResult.configOptions) {
    const modelConfigOption = sessionResult.configOptions.find(
      (o) => o.category === "model"
    );
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
  }

  // Neither mechanism available — warn and continue
  onLog(`Warning: agent does not advertise model selection capability (no models field or model config option); model "${model}" may not be honoured`);
  return undefined;
}

/**
 * Run an ACP session with the Copilot CLI (or any ACP-compatible agent).
 */
export async function runACPSession(
  prompt: string,
  options: ACPClientOptions
): Promise<ACPSessionResult> {
  const { command, args = [], env = {}, cwd, onLog = console.log, mcpServers = [], model, shell = false } = options;
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

    // Select model if requested
    let confirmedModel: string | undefined;
    if (model) {
      confirmedModel = await selectModel(connection, sessionResult, model, onLog);
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
