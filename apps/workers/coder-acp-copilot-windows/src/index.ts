// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { WorkerProcessor, WorkerProcessorOptions, WorkerResult, QueueProcessorConfig, LogEvent, WorkerLogFn, createFreshWorkspace, cleanupWorkspaces } from "@scope/core";
import { TokenManagerClient } from "@scope/secrets";
import { CodingAgentQueueProcessor } from "@scope/worker-runtime";
import { runACPSession } from "./acp-client.js";
import dotenv from "dotenv";

dotenv.config();

/**
 * Build the environment variables for the copilot subprocess on Windows.
 *
 * On Windows, DevProxy sidecars are not supported (Linux containers only),
 * so proxy configuration is always disabled.
 */
export function buildSubprocessEnv(
  githubToken: string,
): Record<string, string> {
  return {
    GITHUB_TOKEN: githubToken,
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    http_proxy: "",
    https_proxy: "",
    NODE_EXTRA_CA_CERTS: "",
  };
}

const WORKER_NAME = process.env.WORKER_NAME || "coder-acp-copilot-windows";
const tokenClient = new TokenManagerClient();
const AGENT_VERSION = `copilot-${process.env.COPILOT_CLI_VERSION || "unknown"}`;

class CopilotWindowsProcessor implements WorkerProcessor {
  readonly workerName = WORKER_NAME;
  workspacePath: string | undefined = undefined;

  getAgentVersion(): string {
    return AGENT_VERSION;
  }

  getComponentVersions(): Record<string, string> {
    return {
      ...(process.env.COPILOT_CLI_VERSION ? { COPILOT_CLI_VERSION: process.env.COPILOT_CLI_VERSION } : {}),
    };
  }

  async setup(log: WorkerLogFn): Promise<void> {
    this.workspacePath = createFreshWorkspace();
    await log("info", "Fresh workspace created", { workspacePath: this.workspacePath });
  }

  async teardown(log: WorkerLogFn): Promise<void> {
    try {
      cleanupWorkspaces();
      await log("info", "Workspaces directory cleaned");
    } catch (error) {
      await log("warn", `Failed to clean workspaces directory: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.workspacePath = undefined;
  }

  async processMessage(
    message: string,
    log: (level: LogEvent["level"], message: string, data?: Record<string, unknown>) => Promise<void>,
    options?: WorkerProcessorOptions
  ): Promise<WorkerResult> {
    await log("info", "Starting Copilot ACP processor (Windows)", {
      inputLength: message.length,
      model: options?.model,
    });

    try {
      const githubToken = await tokenClient.acquireToken("copilot-sdk");
      await log("info", "Acquired GITHUB_TOKEN", {
        preview: `${githubToken.substring(0, 7)}...(${githubToken.length} chars)`,
      });

      const args = ["--acp", "--yolo"];
      if (options?.model) {
        args.push("--model", options.model);
      }

      const result = await runACPSession(message, {
        command: "copilot",
        args,
        env: buildSubprocessEnv(githubToken),
        cwd: this.workspacePath!,
        // Use shell: true on Windows so spawn resolves .cmd shims (e.g. copilot.cmd)
        shell: true,
        onLog: async (msg) => {
          await log("debug", msg);
        },
        mcpServers: [],
        model: options?.model,
      });

      await log("info", "Copilot processing complete", {
        stopReason: result.stopReason,
        responseLength: result.response.length,
      });

      const response = result.response || `[${this.workerName}] No response from Copilot`;
      return { response };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await log("error", `Copilot processing failed: ${errorMessage}`);
      throw error;
    }
  }
}

async function main(): Promise<void> {
  const config: QueueProcessorConfig = {
    mongoUri: process.env.MONGO_CONNECTION_STRING || process.env.MONGO_URI || "mongodb://localhost:27017",
    mongoDatabase: process.env.MONGO_DATABASE || "requests-db",
    mongoCollection: process.env.MONGO_COLLECTION || "requests",
    storageAccountName: process.env.AZURE_STORAGE_ACCOUNT_NAME || "",
    storageConnectionString: process.env.STORAGE_CONNECTION_STRING || process.env.AZURE_STORAGE_CONNECTION_STRING,
    queueName: process.env.QUEUE_NAME || process.env.AZURE_STORAGE_QUEUE_NAME || "queue-coder-acp-copilot-windows",
    batchSize: parseInt(process.env.BATCH_SIZE || "1", 10),
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "1000", 10),
    redisHost: process.env.REDIS_HOST || "",
    redisPort: parseInt(process.env.REDIS_PORT || "6379", 10),
    redisPassword: process.env.REDIS_PASSWORD || "",
    apiBaseUrl: process.env.SCOPE_MT_API_URL,
    tokenManagerUrl: process.env.TOKEN_MANAGER_URL,
  };

  const processor = new CopilotWindowsProcessor();
  const queueProcessor = new CodingAgentQueueProcessor(config, processor);

  await queueProcessor.start();
}

main().catch((error) => {
  console.error("coder-acp-copilot-windows failed to start:", error);
  process.exit(1);
});
