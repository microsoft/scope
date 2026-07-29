// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createProxyClient, isProxyEnabled, McpGatewayClient, type ProxyClient } from "@scope/agent-protocol";
import { WorkerProcessor, WorkerProcessorOptions, WorkerResult, QueueProcessorConfig, LogEvent, WorkerLogFn, McpServerConfig, createFreshWorkspace, cleanupWorkspaces } from "@scope/core";
import { TokenManagerClient } from "@scope/secrets";
import { CodingAgentQueueProcessor } from "@scope/worker-runtime";
import { runACPSession } from "./acp-client.js";
import dotenv from "dotenv";

dotenv.config();

/**
 * Build the environment variables for the copilot subprocess.
 *
 * When DevProxy is active, configures proxy-related env vars so the subprocess
 * routes traffic through the DevProxy MITM proxy.
 * When DevProxy is disabled (or setup failed), strips proxy env vars and clears
 * NODE_EXTRA_CA_CERTS to prevent the subprocess from loading a non-existent cert.
 *
 * @param proxyUrl - Optional session-scoped proxy URL (e.g. http://sessionId@host:port).
 *   When provided, overrides the inherited HTTP_PROXY/HTTPS_PROXY so the subprocess
 *   routes through the correct session.
 */
export function buildSubprocessEnv(
  githubToken: string,
  devProxyEnabled: boolean,
  currentNodeOptions?: string,
  gatewayUrl?: string,
  proxyUrl?: string,
): Record<string, string> {
  const gatewayHost = gatewayUrl ? new URL(gatewayUrl).hostname : null;
  const noProxy = ["localhost", "127.0.0.1", ...(gatewayHost ? [gatewayHost] : [])].join(",");
  return {
    GITHUB_TOKEN: githubToken,
    ...(devProxyEnabled ? {
      NODE_OPTIONS: [currentNodeOptions, "--use-env-proxy"].filter(Boolean).join(" "),
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      NO_PROXY: noProxy,
      no_proxy: noProxy,
      ...(proxyUrl ? {
        HTTP_PROXY: proxyUrl,
        HTTPS_PROXY: proxyUrl,
        http_proxy: proxyUrl,
        https_proxy: proxyUrl,
      } : {}),
    } : {
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      http_proxy: "",
      https_proxy: "",
      NODE_EXTRA_CA_CERTS: "",
    }),
  };
}

const WORKER_NAME = process.env.WORKER_NAME || "coder-acp-copilot";
const tokenClient = new TokenManagerClient();
const AGENT_VERSION = `copilot-${process.env.COPILOT_CLI_VERSION || "unknown"}`;

class CopilotProcessor implements WorkerProcessor {
  readonly workerName = WORKER_NAME;
  workspacePath: string | undefined = undefined;
  private gateway: McpGatewayClient | null = null;
  private mcpConfigs: McpServerConfig[] = [];

  getAgentVersion(): string {
    return AGENT_VERSION;
  }

  getComponentVersions(): Record<string, string> {
    return {
      ...(process.env.COPILOT_CLI_VERSION ? { COPILOT_CLI_VERSION: process.env.COPILOT_CLI_VERSION } : {}),
    };
  }

  async setup(log: WorkerLogFn, options?: WorkerProcessorOptions): Promise<void> {
    this.workspacePath = createFreshWorkspace();
    await log("info", "Fresh workspace created", { workspacePath: this.workspacePath });

    this.mcpConfigs = options?.mcpServerConfigs ?? [];
    if (this.mcpConfigs.length > 0) {
      if (!McpGatewayClient.isEnabled()) {
        throw new Error("MCP servers configured but MCP_GATEWAY_URL is not set — cannot proceed without gateway");
      }
      this.gateway = new McpGatewayClient();
      await log("info", "Registering MCP servers with gateway", { count: this.mcpConfigs.length, servers: this.mcpConfigs.map((s) => s.name) });
      await this.gateway.purgeAll();
      for (const config of this.mcpConfigs) await this.gateway.registerServer(config);
    }
  }

  async teardown(log: WorkerLogFn): Promise<void> {
    if (this.gateway && this.mcpConfigs.length > 0) {
      await Promise.all(this.mcpConfigs.map((c) =>
        this.gateway!.deregisterServer(c.slug).catch((err) => {
          log("warn", `Failed to deregister MCP server "${c.name}" (${c.slug}) — will be purged on next run`, { error: String(err) });
        })
      ));
      this.gateway = null;
    }
    try {
      cleanupWorkspaces();
      await log("info", "Workspaces directory cleaned");
    } catch (error) {
      await log("warn", `Failed to clean workspaces directory: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.workspacePath = undefined;
    this.mcpConfigs = [];
  }

  async processMessage(
    message: string,
    log: (level: LogEvent["level"], message: string, data?: Record<string, unknown>) => Promise<void>,
    options?: WorkerProcessorOptions
  ): Promise<WorkerResult> {
    const skillConfigs = options?.skillConfigs ?? [];
    await log("info", "Starting Copilot ACP processor", {
      inputLength: message.length,
      model: options?.model,
      mcpServerCount: this.mcpConfigs.length,
      mcpServers: this.mcpConfigs.map((s) => ({ name: s.name, type: s.type, url: s.url })),
      skillCount: skillConfigs.length,
      skills: skillConfigs.map((s) => s.name),
    });

    // Proxy integration — start recording if enabled
    let devProxy: ProxyClient | null = null;
    let sslCertFile: string | undefined;
    if (isProxyEnabled()) {
      const proxy = createProxyClient();
      try {
        await log("info", `Proxy enabled [${proxy.backend}] — waiting for sidecar to be ready...`);
        await proxy.waitForReady();
        // Download CA cert if needed (for NODE_EXTRA_CA_CERTS)
        const certPath = process.env.NODE_EXTRA_CA_CERTS || "/tmp/dev-proxy-ca.crt";
        await proxy.downloadCertificate(certPath);
        // Create combined CA bundle for native binaries (SSL_CERT_FILE)
        // The copilot binary is a native executable that doesn't use NODE_EXTRA_CA_CERTS
        const bundlePath = "/tmp/ca-bundle-combined.crt";
        sslCertFile = await proxy.createCombinedCaBundle(certPath, bundlePath);
        await log("info", "Proxy CA cert installed for native binaries", { sslCertFile });
        await proxy.startRecording();
        devProxy = proxy;
        await log("info", `Proxy recording started [${proxy.backend}]`, { proxyUrl: proxy.proxyUrl });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        await log("warn", `DevProxy setup failed, continuing without HAR capture: ${msg}`);
        devProxy = null;
      }
    }

    try {
      // Acquire token dynamically (env var fallback or Token Manager)
      const githubToken = await tokenClient.acquireToken("copilot-cli");
      await log("info", "Acquired GITHUB_TOKEN", {
        preview: `${githubToken.substring(0, 7)}...(${githubToken.length} chars)`,
      });

      // Run ACP session with GitHub Copilot
      const args = ["--acp", "--yolo"];
      if (options?.model) {
        args.push("--model", options.model);
      }
      // The Copilot CLI does not support MCP servers via ACP newSession.mcpServers
      // (agentCapabilities.mcpCapabilities is undefined). Instead, pass the gateway
      // endpoint via --additional-mcp-config so the CLI initializes it at startup.
      if (this.gateway && this.mcpConfigs.length > 0) {
        const mcpConfigJson = JSON.stringify({
          mcpServers: { "mcp-gateway": { type: "http", url: this.gateway.mcpEndpoint } },
        });
        args.push("--additional-mcp-config", mcpConfigJson);
      }
      const result = await runACPSession(message, {
        command: "copilot",
        args,
        env: buildSubprocessEnv(githubToken, !!devProxy, process.env.NODE_OPTIONS, process.env.MCP_GATEWAY_URL, devProxy?.proxyUrl),
        cwd: this.workspacePath!,
        onLog: async (msg) => {
          await log("debug", msg);
        },
        mcpServers: [],
        model: options?.model,
      });

      await log("info", "Copilot processing complete", { 
        stopReason: result.stopReason,
        responseLength: result.response.length 
      });

      const response = result.response || `[${this.workerName}] No response from Copilot`;
      const { harFilePath, tokenUsage, aiCallCount } = devProxy
        ? await devProxy.stopAndCollectHar(log)
        : { harFilePath: null, tokenUsage: undefined, aiCallCount: undefined };
      return { response, ...(harFilePath && { harFilePath }), ...(tokenUsage && { tokenUsage }), ...(aiCallCount !== undefined && { aiCallCount }) };
    } catch (error) {
      if (devProxy) {
        const { harFilePath, aiCallCount } = await devProxy.stopAndCollectHar(log);
        if (harFilePath) {
          (error as any).harFilePath = harFilePath;
        }
        if (aiCallCount !== undefined) {
          (error as any).aiCallCount = aiCallCount;
        }
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      await log("error", `Copilot processing failed: ${errorMessage}`);
      throw error;
    }
  }
}

async function main(): Promise<void> {
  // K8s: MONGO_CONNECTION_STRING from secret, STORAGE_CONNECTION_STRING from secret, QUEUE_NAME from deployment env
  const config: QueueProcessorConfig = {
    mongoUri: process.env.MONGO_CONNECTION_STRING || process.env.MONGO_URI || "mongodb://localhost:27017",
    mongoDatabase: process.env.MONGO_DATABASE || "requests-db",
    mongoCollection: process.env.MONGO_COLLECTION || "requests",
    storageAccountName: process.env.AZURE_STORAGE_ACCOUNT_NAME || "",
    storageConnectionString: process.env.STORAGE_CONNECTION_STRING || process.env.AZURE_STORAGE_CONNECTION_STRING,
    queueName: process.env.QUEUE_NAME || process.env.AZURE_STORAGE_QUEUE_NAME || "queue-coder-acp-copilot",
    batchSize: parseInt(process.env.BATCH_SIZE || "1", 10),
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "1000", 10),
    redisHost: process.env.REDIS_HOST || "",
    redisPort: parseInt(process.env.REDIS_PORT || "6379", 10),
    redisPassword: process.env.REDIS_PASSWORD || "",
    apiBaseUrl: process.env.SCOPE_MT_API_URL,
    tokenManagerUrl: process.env.TOKEN_MANAGER_URL,
    postProcessorQueueName: process.env.QUEUE_NAME_POST_PROCESSOR || "post-processor-queue",
  };

  const processor = new CopilotProcessor();
  const queueProcessor = new CodingAgentQueueProcessor(config, processor);

  await queueProcessor.start();
}

main().catch((error) => {
  console.error("coder-acp-copilot failed to start:", error);
  process.exit(1);
});
