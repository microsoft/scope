// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  CopilotClient,
  RuntimeConnection,
  defineTool,
  type CopilotClientOptions,
  type CopilotSession,
  type SessionConfig,
  type Tool,
} from "@github/copilot-sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterContext } from "../adapter/protocol.js";
import { record, requiredString } from "../adapter/validation.js";

export const LOCAL_MAX_TURNS = 20;
export const LOCAL_MAX_AI_CREDITS = 200;

export function localClientOptions(
  token: string,
  directory: string,
  cliPath: string,
  environment = process.env,
): CopilotClientOptions {
  const env: Record<string, string> = {};
  for (const name of [
    "PATH", "TMPDIR", "TMP", "TEMP", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC",
    "PATHEXT", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
    "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
  ]) {
    const value = environment[name];
    if (value) env[name] = value;
  }
  env.HOME = directory;
  env.USERPROFILE = directory;
  env.XDG_CONFIG_HOME = directory;
  return {
    mode: "empty",
    baseDirectory: join(directory, "state"),
    workingDirectory: directory,
    connection: RuntimeConnection.forStdio({
      path: cliPath,
      args: ["--disable-builtin-mcps", "--max-ai-credits", String(LOCAL_MAX_AI_CREDITS)],
    }),
    env,
    gitHubToken: token,
    useLoggedInUser: false,
    logLevel: "error",
  };
}

export function denyLocalPermission() {
  return { kind: "reject" as const };
}

export function localSessionConfig(model: string, systemPrompt: string, tools: Tool[]): SessionConfig {
  return {
    model,
    tools,
    availableTools: ["custom:contribution_report"],
    excludedTools: ["builtin:*", "mcp:*"],
    systemMessage: { mode: "replace", content: systemPrompt },
    onPermissionRequest: denyLocalPermission,
    enableConfigDiscovery: false,
    skipCustomInstructions: true,
    enableOnDemandInstructionDiscovery: false,
    enableFileHooks: false,
    enableHostGitOperations: false,
    enableSessionStore: false,
    enableSessionTelemetry: false,
    enableSkills: false,
    skillDirectories: [],
    disabledSkills: ["*"],
    pluginDirectories: [],
    instructionDirectories: [],
    mcpServers: {},
    customAgents: [],
    customAgentsLocalOnly: true,
    requestCanvasRenderer: false,
    requestExtensions: false,
    infiniteSessions: { enabled: false },
    skipEmbeddingRetrieval: true,
    embeddingCacheStorage: "in-memory",
    mcpOAuthTokenStorage: "in-memory",
    remoteSession: "off",
    streaming: false,
  };
}

export function createLocalCopilotContext(options: {
  token: string;
  cliPath: string;
  model: string;
  timeoutMs: number;
}): AdapterContext {
  return {
    model: options.model,
    async complete(request, completionOptions) {
      if (request.messages.length !== 2 || request.messages[0].role !== "system" ||
        request.messages[1].role !== "user" || request.tools?.length !== 1 ||
        request.tools[0].name !== "contribution_report" || !completionOptions?.executeTool) {
        throw new Error("Local Copilot accepts only the owned contribution prompt and report tool");
      }
      const directory = await mkdtemp(join(tmpdir(), "scope-contribution-copilot-"));
      let client: CopilotClient | undefined;
      let session: CopilotSession | undefined;
      let failure: unknown;
      let completion: { content: string; metadata: Record<string, unknown> } | undefined;
      const cleanupErrors: unknown[] = [];
      try {
        client = new CopilotClient(localClientOptions(options.token, directory, options.cliPath));
        let submitted: string | undefined;
        let attempts = 0;
        let turns = 0;
        let turnLimit: Error | undefined;
        let inputTokens = 0;
        let outputTokens = 0;
        const models = new Set<string>();
        const events = new Set<string>();
        const aborts: Promise<void>[] = [];
        const definition = request.tools[0];
        const executeTool = completionOptions.executeTool;
        const reportTool = defineTool(definition.name, {
          description: definition.description,
          parameters: record(definition.parameters, "report parameters"),
          skipPermission: true,
          async handler(arguments_: unknown) {
            if (++attempts !== 1) throw new Error("Only one contribution report submission is permitted");
            const value = record(arguments_, "report arguments");
            const report = requiredString(value.report, "report");
            const result = await executeTool("contribution_report", value);
            submitted = report;
            return result;
          },
        });
        await client.start();
        const status = await client.getStatus();
        session = await client.createSession(localSessionConfig(options.model, request.messages[0].content, [reportTool]));
        const currentSession = session;
        await currentSession.rpc.tools.initializeAndValidate();
        const catalog = await currentSession.rpc.tools.getCurrentMetadata();
        if (catalog.tools?.length !== 1 || catalog.tools[0].name !== "contribution_report") {
          throw new Error("Local runtime did not expose exactly the report-only tool");
        }
        const unsubscribe = currentSession.on((event) => {
          events.add(event.type);
          if (event.type === "assistant.turn_start" && ++turns > LOCAL_MAX_TURNS && !turnLimit) {
            turnLimit = new Error(`Local Copilot exceeded ${LOCAL_MAX_TURNS} model turns`);
            aborts.push(currentSession.abort().catch((error: unknown) => { cleanupErrors.push(error); }));
          }
          if (event.type === "assistant.usage") {
            inputTokens += event.data.inputTokens ?? 0;
            outputTokens += event.data.outputTokens ?? 0;
            models.add(event.data.model);
          }
        });
        try {
          const response = await currentSession.sendAndWait({ prompt: request.messages[1].content }, options.timeoutMs);
          if (turnLimit) throw turnLimit;
          if (!submitted) {
            throw new Error(
              `Copilot did not submit a validated contribution_report (turns=${turns}, reportAttempts=${attempts}, events=${[...events].join(",")}). ` +
              `Response: ${response?.data.content?.slice(0, 2_000) || "(no assistant message)"}`,
            );
          }
          completion = {
            content: submitted,
            metadata: {
              source: "local-copilot-sdk", fidelity: "partial", requestedModel: options.model,
              models: [...models], runtimeVersion: status.version,
              turns, inputTokens, outputTokens,
              maxTurns: LOCAL_MAX_TURNS, requestedMaxAiCredits: LOCAL_MAX_AI_CREDITS,
            },
          };
        } finally {
          unsubscribe();
          for (const result of await Promise.allSettled(aborts)) {
            if (result.status === "rejected") cleanupErrors.push(result.reason);
          }
        }
      } catch (error: unknown) {
        failure = error;
      } finally {
        if (session && client) {
          try {
            await client.deleteSession(session.sessionId);
          } catch (error: unknown) {
            cleanupErrors.push(error);
          }
        }
        if (client) {
          try {
            const errors = await client.stop();
            cleanupErrors.push(...errors);
            if (errors.length) await client.forceStop();
          } catch (error: unknown) {
            cleanupErrors.push(error);
            try {
              await client.forceStop();
            } catch (forceError: unknown) {
              cleanupErrors.push(forceError);
            }
          }
        }
        try {
          await rm(directory, { recursive: true, force: true });
        } catch (error: unknown) {
          cleanupErrors.push(error);
        }
      }
      if (failure || cleanupErrors.length) {
        throw new AggregateError(
          [...(failure ? [failure] : []), ...cleanupErrors],
          [...(failure ? [failure] : []), ...cleanupErrors].map((error) =>
            error instanceof Error ? error.message : String(error)).join("; "),
        );
      }
      if (!completion) throw new Error("Local Copilot completed without a report");
      return completion;
    },
  };
}
