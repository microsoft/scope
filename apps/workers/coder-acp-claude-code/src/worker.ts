// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  CodingAgentQueueProcessor,
  WorkerProcessor,
  WorkerProcessorOptions,
  WorkerResult,
  QueueProcessorConfig,
  LogEvent,
  WorkerLogFn,
  TokenManagerClient,
  createProxyClient,
  isProxyEnabled,
  type ProxyClient,
  McpGatewayClient,
  McpServerConfig,
  KubedockClient,
  createFreshWorkspace,
  cleanupWorkspaces,
} from "shared";
import { initTelemetry, trackMetric, trackTrace, trackEvent } from "telemetry";
import { runACPSession } from "./acp-client.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Runtime overrides used by tests and by the local host-worker wrapper. */
export interface ClaudeCodeWorkerRuntime {
  workerName?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  agentVersion?: string;
  componentVersions?: Record<string, string>;
  /** Reuse the installed CLI's login and inherited proxy settings. */
  hostLogin?: boolean;
  /**
   * Host-only isolation preserves HOME/CLAUDE_CONFIG_DIR login reuse while
   * excluding personal Claude settings/MCP config for reproducible benchmarks.
   */
  isolateHostConfig?: boolean;
  workspaceRoot?: string;
  captureProxy?: boolean;
}

const WORKER_NAME = process.env.WORKER_NAME || "coder-acp-claude-code";
const AGENT_VERSION =
  `claude-agent-acp-${process.env.CLAUDE_CODE_ACP_VERSION || "unknown"}` +
  `-sdk-${process.env.CLAUDE_AGENT_SDK_VERSION || "unknown"}`;

interface WorkerErrorMetadata {
  harFilePath?: string;
  aiCallCount?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Detect the first structured "AI turn" signal from a subprocess log line.
 */
function isFirstAiCallSignal(msg: string): boolean {
  if (msg.includes("createTurn")) return true;
  const trimmed = msg.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return isRecord(parsed) && typeof parsed.type === "string";
    } catch {
      return false;
    }
  }
  return false;
}

/** Queue processor that runs one Claude Code ACP benchmark attempt per message. */
export class ClaudeCodeProcessor implements WorkerProcessor {
  readonly workerName: string;
  workspacePath: string | undefined = undefined;
  private gateway: McpGatewayClient | null = null;
  private mcpConfigs: McpServerConfig[] = [];
  private static coldStartTracked = false;
  private kubedock: KubedockClient | null = null;

  constructor(private readonly runtime: ClaudeCodeWorkerRuntime = {}) {
    this.workerName = runtime.workerName ?? WORKER_NAME;
  }

  /** Return the exact worker/adapter version recorded on run output. */
  getAgentVersion(): string {
    return this.runtime.agentVersion ?? AGENT_VERSION;
  }

  /** Return component versions used by reports and agent registration. */
  getComponentVersions(): Record<string, string> {
    if (this.runtime.componentVersions) return this.runtime.componentVersions;
    return {
      ...(process.env.CLAUDE_CODE_ACP_VERSION ? { CLAUDE_CODE_ACP_VERSION: process.env.CLAUDE_CODE_ACP_VERSION } : {}),
      ...(process.env.CLAUDE_AGENT_SDK_VERSION
        ? { CLAUDE_AGENT_SDK_VERSION: process.env.CLAUDE_AGENT_SDK_VERSION }
        : {}),
    };
  }

  /** Create the run workspace and register requested MCP servers with the gateway. */
  async setup(log: WorkerLogFn, options?: WorkerProcessorOptions): Promise<void> {
    if (this.runtime.workspaceRoot) {
      mkdirSync(this.runtime.workspaceRoot, { recursive: true });
      this.workspacePath = mkdtempSync(join(this.runtime.workspaceRoot, "project-"));
    } else {
      this.workspacePath = createFreshWorkspace();
    }
    await log("info", "Fresh workspace created", { workspacePath: this.workspacePath });

    // Purge orphan containers from previous runs (crash recovery)
    if (KubedockClient.isEnabled()) {
      this.kubedock = new KubedockClient();
      try {
        const purged = await this.kubedock.purgeContainers();
        if (purged > 0) await log("info", "Purged orphan containers from previous run", { count: purged });
      } catch (err) {
        await log("warn", `Failed to purge orphan containers — continuing anyway`, { error: String(err) });
      }
    }

    this.mcpConfigs = options?.mcpServerConfigs ?? [];
    if (this.mcpConfigs.length > 0) {
      if (!McpGatewayClient.isEnabled()) {
        throw new Error("MCP servers configured but MCP_GATEWAY_URL is not set — cannot proceed without gateway");
      }
      this.gateway = new McpGatewayClient();
      await log("info", "Registering MCP servers with gateway", {
        count: this.mcpConfigs.length,
        servers: this.mcpConfigs.map((s) => s.name),
      });
      await this.gateway.purgeAll();
      for (const config of this.mcpConfigs) await this.gateway.registerServer(config);
    }
  }

  /** Deregister run-scoped MCP servers and remove workspaces created in setup(). */
  async teardown(log: WorkerLogFn): Promise<void> {
    // Clean up containers spawned during this run
    if (this.kubedock) {
      try {
        const removed = await this.kubedock.purgeContainers();
        if (removed > 0) await log("info", "Cleaned up containers from run", { count: removed });
      } catch (err) {
        await log("warn", `Failed to clean up containers — will be purged on next run`, { error: String(err) });
      }
      this.kubedock = null;
    }

    if (this.gateway && this.mcpConfigs.length > 0) {
      await Promise.all(this.mcpConfigs.map((c) =>
        this.gateway!.deregisterServer(c.slug).catch((err) => {
          log(
            "warn",
            `Failed to deregister MCP server "${c.name}" (${c.slug}) — will be purged on next run`,
            { error: String(err) },
          );
        })
      ));
      this.gateway = null;
    }
    try {
      if (this.runtime.workspaceRoot) {
        if (this.workspacePath) rmSync(this.workspacePath, { recursive: true, force: true });
      } else {
        cleanupWorkspaces();
      }
      await log("info", "Workspaces directory cleaned");
    } catch (error) {
      await log(
        "warn",
        `Failed to clean workspaces directory: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.workspacePath = undefined;
    this.mcpConfigs = [];
  }

  async processMessage(
    message: string,
    log: (level: LogEvent["level"], message: string, data?: Record<string, unknown>) => Promise<void>,
    options?: WorkerProcessorOptions
  ): Promise<WorkerResult> {
    const runStartTime = Date.now();
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const workerType = this.workerName;
    let firstAiCallTracked = false;
    let lastProtocolEventTime = Date.now();

    // Periodically emit subprocess idle gaps during active runs
    const idleMonitor = setInterval(() => {
      const gapMs = Date.now() - lastProtocolEventTime;
      if (gapMs > 60_000) {
        trackMetric({
          name: "worker.subprocess_idle_s",
          value: gapMs / 1000,
          properties: { runId, workerType },
        });
      }
    }, 30_000);

    const skillConfigs = options?.skillConfigs ?? [];
    await log("info", "Starting Claude Code ACP processor", {
      inputLength: message.length,
      model: options?.model,
      reasoningEffort: options?.reasoningEffort,
      mcpServerCount: this.mcpConfigs.length,
      mcpServers: this.mcpConfigs.map((s) => ({ name: s.name, type: s.type, url: s.url })),
      skillCount: skillConfigs.length,
      skills: skillConfigs.map((s) => s.name),
    });

    trackEvent({
      name: "worker.run_started",
      properties: { runId, workerType, model: options?.model || "default" },
    });

    // Proxy integration — start recording if enabled
    let devProxy: ProxyClient | null = null;
    if (this.runtime.captureProxy !== false && isProxyEnabled()) {
      const proxy = createProxyClient();
      try {
        await log("info", `Proxy enabled [${proxy.backend}] — waiting for sidecar to be ready...`);
        await proxy.waitForReady();
        const certPath = this.runtime.workspaceRoot
          ? join(this.workspacePath!, ".scope-proxy-ca.crt")
          : process.env.NODE_EXTRA_CA_CERTS || "/tmp/dev-proxy-ca.crt";
        await proxy.downloadCertificate(certPath);
        await log("info", "Proxy CA cert installed", { certPath });
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
      // Prefer OAuth tokens over API keys
      const env: Record<string, string> = {
        ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
        ...this.runtime.env,
      };
      if (!this.runtime.hostLogin) {
        const tokenResponse = await new TokenManagerClient().acquireTokenFull("claude-code-cli", "anthropic-oauth");
        const envVarName = tokenResponse.keyType === "anthropic-oauth"
          ? "CLAUDE_CODE_OAUTH_TOKEN"
          : "ANTHROPIC_API_KEY";
        env[envVarName] = tokenResponse.value;
        await log("info", `Acquired ${envVarName}`, {
          preview: `${tokenResponse.value.substring(0, 7)}...(${tokenResponse.value.length} chars)`,
          keyType: tokenResponse.keyType,
        });
      }
      if (options?.model) {
        env.ANTHROPIC_MODEL = options.model;
      }
      // When proxy is active, ensure the subprocess routes through the proxy
      if (devProxy) {
        const existingNodeOptions = process.env.NODE_OPTIONS || "";
        env.NODE_OPTIONS = [existingNodeOptions, "--use-env-proxy"].filter(Boolean).join(" ");
        env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
        const gatewayHost = process.env.MCP_GATEWAY_URL ? new URL(process.env.MCP_GATEWAY_URL).hostname : null;
        const noProxy = ["localhost", "127.0.0.1", ...(gatewayHost ? [gatewayHost] : [])].join(",");
        env.NO_PROXY = noProxy;
        env.no_proxy = noProxy;
        // Use session-scoped proxy URL so the gateway can resolve the exact session
        // from the Proxy-Authorization header instead of relying on IP-based lookup.
        env.HTTP_PROXY = devProxy.proxyUrl;
        env.HTTPS_PROXY = devProxy.proxyUrl;
        env.http_proxy = devProxy.proxyUrl;
        env.https_proxy = devProxy.proxyUrl;
      } else if (!this.runtime.hostLogin && !isProxyEnabled()) {
        // Proxy not configured — clear proxy vars so subprocess makes direct calls
        env.HTTP_PROXY = "";
        env.HTTPS_PROXY = "";
        env.http_proxy = "";
        env.https_proxy = "";
        env.NODE_EXTRA_CA_CERTS = "";
      }
      // MCP gateway lifecycle is handled in setup()/teardown() — servers are already registered.
      // Host isolation is passed as ACP metadata so Claude Code ignores personal
      // setting sources/MCP config while HOME and CLAUDE_CONFIG_DIR stay intact
      // for installed-login reuse.
      const result = await runACPSession(message, {
        command: this.runtime.command ?? "claude-agent-acp",
        args: this.runtime.args ?? [],
        env,
        cwd: this.workspacePath!,
        onLog: async (msg) => {
          lastProtocolEventTime = Date.now();
          if (!firstAiCallTracked && isFirstAiCallSignal(msg)) {
            firstAiCallTracked = true;
            trackMetric({
              name: "worker.first_ai_call_ms",
              value: Date.now() - runStartTime,
              properties: { runId, workerType },
            });
          }
          trackTrace({
            message: msg,
            severityLevel: "Verbose",
            properties: { runId, workerType },
          });
          await log("debug", msg);
        },
        mcpServers: this.gateway && this.mcpConfigs.length > 0
          ? [{
            type: "http" as const,
            slug: "mcp-gateway",
            name: "mcp-gateway",
            url: this.gateway.mcpEndpoint,
          }]
          : [],
        reasoningEffort: options?.reasoningEffort,
        ...(this.runtime.isolateHostConfig ? { isolateHostConfig: true } : {}),
      });

      await log("info", "Claude Code processing complete", {
        stopReason: result.stopReason,
        responseLength: result.response.length
      });

      const runDurationMs = Date.now() - runStartTime;
      trackMetric({
        name: "worker.run_duration_ms",
        value: runDurationMs,
        properties: { runId, workerType, stopReason: result.stopReason },
      });

      if (!ClaudeCodeProcessor.coldStartTracked) {
        ClaudeCodeProcessor.coldStartTracked = true;
        trackMetric({
          name: "worker.cold_start_ms",
          value: process.uptime() * 1000,
          properties: { workerType },
        });
      }

      const subprocessIdleS = (Date.now() - lastProtocolEventTime) / 1000;
      trackMetric({
        name: "worker.subprocess_idle_s",
        value: subprocessIdleS,
        properties: { runId, workerType },
      });

      clearInterval(idleMonitor);

      const response = result.response || `[${this.workerName}] No response from Claude Code`;
      const { harFilePath, tokenUsage, aiCallCount } = devProxy
        ? await devProxy.stopAndCollectHar(log)
        : { harFilePath: null, tokenUsage: undefined, aiCallCount: undefined };
      return {
        response,
        ...(harFilePath && { harFilePath }),
        ...(tokenUsage && { tokenUsage }),
        ...(aiCallCount !== undefined && { aiCallCount }),
      };
    } catch (error) {
      if (devProxy) {
        const { harFilePath, aiCallCount } = await devProxy.stopAndCollectHar(log);
        const errorWithMetadata = error as Error & WorkerErrorMetadata;
        if (harFilePath) {
          errorWithMetadata.harFilePath = harFilePath;
        }
        if (aiCallCount !== undefined) {
          errorWithMetadata.aiCallCount = aiCallCount;
        }
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      await log("error", `Claude Code processing failed: ${errorMessage}`);
      clearInterval(idleMonitor);
      throw error;
    }
  }
}

/** Start the queue processor with environment-derived storage, Redis and API settings. */
export async function startClaudeCodeWorker(runtime: ClaudeCodeWorkerRuntime = {}): Promise<void> {
  initTelemetry(runtime.workerName ?? WORKER_NAME);
  // K8s: MONGO_CONNECTION_STRING from secret, STORAGE_CONNECTION_STRING from secret, QUEUE_NAME from deployment env
  const config: QueueProcessorConfig = {
    mongoUri: process.env.MONGO_CONNECTION_STRING || process.env.MONGO_URI || "mongodb://localhost:27017",
    mongoDatabase: process.env.MONGO_DATABASE || "requests-db",
    mongoCollection: process.env.MONGO_COLLECTION || "requests",
    storageAccountName: process.env.AZURE_STORAGE_ACCOUNT_NAME || "",
    storageConnectionString: process.env.STORAGE_CONNECTION_STRING || process.env.AZURE_STORAGE_CONNECTION_STRING,
    queueName: runtime.workerName
      ? `queue-${runtime.workerName}`
      : process.env.QUEUE_NAME || process.env.AZURE_STORAGE_QUEUE_NAME || "queue-coder-acp-claude-code",
    batchSize: parseInt(process.env.BATCH_SIZE || "1", 10),
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "1000", 10),
    redisHost: process.env.REDIS_HOST || "",
    redisPort: parseInt(process.env.REDIS_PORT || "6379", 10),
    redisPassword: process.env.REDIS_PASSWORD || "",
    apiBaseUrl: process.env.SCOPE_MT_API_URL,
    tokenManagerUrl: process.env.TOKEN_MANAGER_URL,
    postProcessorQueueName: process.env.QUEUE_NAME_POST_PROCESSOR || "post-processor-queue",
  };

  const processor = new ClaudeCodeProcessor(runtime);
  const queueProcessor = new CodingAgentQueueProcessor(config, processor);

  await queueProcessor.start();
}
