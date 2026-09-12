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
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Runtime overrides used by tests and by the local host-worker wrapper. */
export interface CopilotWorkerRuntime {
  workerName?: string;
  command?: string;
  agentVersion?: string;
  componentVersions?: Record<string, string>;
  /** Reuse the installed CLI's login and inherited proxy settings. */
  hostLogin?: boolean;
  /**
   * Host-only isolation preserves HOME login reuse while disabling personal MCP
   * servers/settings for reproducible benchmarks.
   */
  isolateHostConfig?: boolean;
  /** Optional test override; production host isolation reads ~/.copilot/mcp-config.json read-only. */
  personalMcpConfigPath?: string;
  workspaceRoot?: string;
  captureProxy?: boolean;
}

/** CLI arguments generated to neutralize personal MCP configuration on host runs. */
export interface CopilotHostMcpIsolation {
  args: string[];
  disabledServers: string[];
}

type PersonalMcpConfigReadResult = {
  disabledServers: string[];
  status: "loaded" | "missing" | "unreadable" | "empty" | "malformed" | "no-servers";
  error?: string;
};

interface WorkerErrorMetadata {
  harFilePath?: string;
  aiCallCount?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPersonalCopilotMcpServers(configPath: string): PersonalMcpConfigReadResult {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : undefined;
    return {
      disabledServers: [],
      status: code === "ENOENT" ? "missing" : "unreadable",
      ...(error instanceof Error ? { error: error.message } : { error: String(error) }),
    };
  }

  if (raw.trim().length === 0) {
    return { disabledServers: [], status: "empty" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    return {
      disabledServers: [],
      status: "malformed",
      ...(error instanceof Error ? { error: error.message } : { error: String(error) }),
    };
  }

  const mcpServers = isRecord(parsed) && isRecord(parsed.mcpServers)
    ? parsed.mcpServers
    : undefined;
  if (!mcpServers) {
    return { disabledServers: [], status: "no-servers" };
  }

  return {
    disabledServers: Object.keys(mcpServers).sort(),
    status: "loaded",
  };
}

/**
 * Build Copilot CLI flags that isolate host runs from personal MCP config while
 * leaving HOME untouched so the host worker can reuse the user's existing
 * Copilot login for reproducible benchmark execution.
 */
export async function buildCopilotHostMcpIsolation(
  log: WorkerLogFn,
  configPath = join(homedir(), ".copilot", "mcp-config.json"),
): Promise<CopilotHostMcpIsolation> {
  const readResult = readPersonalCopilotMcpServers(configPath);
  if (readResult.status !== "loaded") {
    const level: LogEvent["level"] =
      readResult.status === "malformed" || readResult.status === "unreadable" ? "warn" : "info";
    await log(level, "Personal Copilot MCP config could not be loaded; continuing with built-in MCPs disabled", {
      configPath,
      status: readResult.status,
      ...(readResult.error ? { error: readResult.error } : {}),
    });
  }

  await log("info", "Disabling personal Copilot MCP servers for reproducible host run", {
    configPath,
    disabledServers: readResult.disabledServers,
  });

  return {
    args: [
      "--disable-builtin-mcps",
      ...readResult.disabledServers.flatMap((name) => ["--disable-mcp-server", name]),
    ],
    disabledServers: readResult.disabledServers,
  };
}

/** Choose a gateway server name that cannot be disabled by copied personal MCP flags. */
function chooseCopilotGatewayServerName(disabledServerNames: readonly string[]): string {
  const disabled = new Set(disabledServerNames);
  if (!disabled.has("mcp-gateway")) return "mcp-gateway";
  let index = 1;
  while (disabled.has(`scope-mcp-gateway-${index}`)) {
    index += 1;
  }
  return `scope-mcp-gateway-${index}`;
}

/**
 * Detect the first structured "AI turn" signal from a subprocess log line.
 *
 * Prefers an explicit "createTurn" marker or a JSON-parseable message carrying a
 * `type` field, rather than a loose substring match on "turn".
 */
export function isFirstAiCallSignal(msg: string): boolean {
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

/**
 * Build the environment variables for the copilot subprocess.
 *
 * When the proxy is active, configures proxy-related env vars so the subprocess
 * routes model traffic through the MITM proxy (DevProxy or gateway) for HAR
 * capture. The Copilot CLI is a Node.js app, so it trusts the proxy's MITM cert
 * via NODE_EXTRA_CA_CERTS (set from `certPath`).
 *
 * The GitHub auth endpoints (github.com/api.github.com) are excluded from the
 * proxy via NO_PROXY so the CLI's auth + Copilot-token-mint handshake goes
 * direct. The gateway performs TLS interception, and the CLI rejects the
 * gateway's CA on those endpoints with a `UnknownCA` fatal alert (surfacing as
 * `-32000 Authentication required`); bypassing the proxy for auth avoids this
 * while still recording the model endpoint's WebSocket traffic. Mirrors the
 * Windows Copilot worker, which already runs on the gateway.
 *
 * When the proxy is disabled (or setup failed), strips proxy env vars and clears
 * NODE_EXTRA_CA_CERTS to prevent the subprocess from loading a non-existent cert.
 *
 * @param proxyUrl - Optional session-scoped proxy URL (e.g. http://sessionId@host:port).
 *   When provided, overrides the inherited HTTP_PROXY/HTTPS_PROXY so the subprocess
 *   routes through the correct session.
 * @param certPath - Optional path to a CA bundle (system CAs + proxy CA). When
 *   provided, set as NODE_EXTRA_CA_CERTS so the Node-based CLI trusts the proxy's
 *   MITM cert for the intercepted model endpoint.
 */
export function buildSubprocessEnv(
  githubToken: string,
  devProxyEnabled: boolean,
  currentNodeOptions?: string,
  gatewayUrl?: string,
  proxyUrl?: string,
  certPath?: string,
): Record<string, string> {
  const gatewayHost = gatewayUrl ? new URL(gatewayUrl).hostname : null;
  const noProxy = [
    "localhost",
    "127.0.0.1",
    // Exclude auth endpoints so the CLI's github.com/api.github.com auth +
    // Copilot-token-mint handshake goes direct instead of through the gateway's
    // TLS interception (which the CLI rejects with UnknownCA, breaking auth).
    "github.com",
    "api.github.com",
    ...(gatewayHost ? [gatewayHost] : []),
  ].join(",");
  return {
    GITHUB_TOKEN: githubToken,
    // Disable the Copilot CLI in-session auto-updater. In headless --acp --yolo
    // mode it downloads a newer binary mid-run, logs "restart to update", and then
    // never restarts under ACP — wedging the process before the first model
    // completion until the 60-min ACP timeout (0 turns / 0 AI calls / 0 tokens).
    // See issue #1179.
    COPILOT_AUTO_UPDATE: "false",
    ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
    ...(devProxyEnabled ? {
      NODE_OPTIONS: [currentNodeOptions, "--use-env-proxy"].filter(Boolean).join(" "),
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      ...(certPath ? { NODE_EXTRA_CA_CERTS: certPath } : {}),
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
const AGENT_VERSION = `copilot-${process.env.COPILOT_CLI_VERSION || "unknown"}`;

/** Queue processor that runs one Copilot ACP benchmark attempt per message. */
export class CopilotProcessor implements WorkerProcessor {
  static coldStartTracked = false;
  readonly workerName: string;
  workspacePath: string | undefined = undefined;
  private gateway: McpGatewayClient | null = null;
  private mcpConfigs: McpServerConfig[] = [];
  private kubedock: KubedockClient | null = null;

  constructor(private readonly runtime: CopilotWorkerRuntime = {}) {
    this.workerName = runtime.workerName ?? WORKER_NAME;
  }

  /** Return the exact worker/CLI version recorded on run output. */
  getAgentVersion(): string {
    return this.runtime.agentVersion ?? AGENT_VERSION;
  }

  /** Return component versions used by reports and agent registration. */
  getComponentVersions(): Record<string, string> {
    if (this.runtime.componentVersions) return this.runtime.componentVersions;
    return {
      ...(process.env.COPILOT_CLI_VERSION ? { COPILOT_CLI_VERSION: process.env.COPILOT_CLI_VERSION } : {}),
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
    let lastProtocolEventTime = runStartTime;

    // Periodically emit subprocess idle gaps during active runs so long stalls are
    // observable even before the run completes.
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
    await log("info", "Starting Copilot ACP processor", {
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
    let caCertBundlePath: string | undefined;
    if (this.runtime.captureProxy !== false && isProxyEnabled()) {
      const proxy = createProxyClient();
      try {
        await log("info", `Proxy enabled [${proxy.backend}] — waiting for sidecar to be ready...`);
        await proxy.waitForReady();
        // Download the proxy CA cert and build a combined bundle (system CAs +
        // proxy CA). The Copilot CLI is a Node.js app, so it trusts this bundle
        // via NODE_EXTRA_CA_CERTS — required for the gateway's TLS interception
        // of the model endpoint (githubcopilot.com) to succeed. Auth endpoints
        // (github.com/api.github.com) bypass the proxy (see NO_PROXY in
        // buildSubprocessEnv), so they are never intercepted.
        const certPath = this.runtime.workspaceRoot
          ? join(this.workspacePath!, ".scope-proxy-ca.crt")
          : process.env.NODE_EXTRA_CA_CERTS || "/tmp/dev-proxy-ca.crt";
        await proxy.downloadCertificate(certPath);
        const bundlePath = this.runtime.workspaceRoot
          ? join(this.workspacePath!, ".scope-ca-bundle.crt")
          : "/tmp/ca-bundle-combined.crt";
        caCertBundlePath = await proxy.createCombinedCaBundle(certPath, bundlePath);
        await log("info", "Proxy CA cert installed for the Copilot CLI", { caCertBundlePath });
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
      let githubToken = "";
      if (!this.runtime.hostLogin) {
        githubToken = await new TokenManagerClient().acquireToken("copilot-cli");
        await log("info", "Acquired GITHUB_TOKEN", {
          preview: `${githubToken.substring(0, 7)}...(${githubToken.length} chars)`,
        });
      }
      const env = this.runtime.hostLogin && !devProxy
        ? { COPILOT_AUTO_UPDATE: "false" }
        : buildSubprocessEnv(
          githubToken,
          !!devProxy,
          process.env.NODE_OPTIONS,
          process.env.MCP_GATEWAY_URL,
          devProxy?.proxyUrl,
          caCertBundlePath,
        );
      if (this.runtime.hostLogin) delete env.GITHUB_TOKEN;

      // Run ACP session with GitHub Copilot
      // --no-auto-update prevents the CLI from self-updating mid-session (see #1179).
      const args = ["--acp", "--yolo", "--no-auto-update"];
      if (options?.model) {
        args.push("--model", options.model);
      }
      if (options?.reasoningEffort) {
        args.push("--reasoning-effort", options.reasoningEffort);
      }
      const hostMcpIsolation = this.runtime.isolateHostConfig
        ? await buildCopilotHostMcpIsolation(log, this.runtime.personalMcpConfigPath)
        : { args: [], disabledServers: [] };
      args.push(...hostMcpIsolation.args);
      // The Copilot CLI does not support MCP servers via ACP newSession.mcpServers
      // (agentCapabilities.mcpCapabilities is undefined). Instead, pass the gateway
      // endpoint via --additional-mcp-config so the CLI initializes it at startup.
      if (this.gateway && this.mcpConfigs.length > 0) {
        const gatewayServerName = chooseCopilotGatewayServerName(hostMcpIsolation.disabledServers);
        const mcpConfigJson = JSON.stringify({
          mcpServers: { [gatewayServerName]: { type: "http", url: this.gateway.mcpEndpoint } },
        });
        args.push("--additional-mcp-config", mcpConfigJson);
      }
      const result = await runACPSession(message, {
        command: this.runtime.command ?? "copilot",
        args,
        env,
        authenticate: !this.runtime.hostLogin,
        cwd: this.workspacePath!,
        onLog: async (msg) => {
          lastProtocolEventTime = Date.now();
          // Track first AI call timing
          if (!firstAiCallTracked && isFirstAiCallSignal(msg)) {
            firstAiCallTracked = true;
            const firstAiCallMs = Date.now() - runStartTime;
            trackMetric({
              name: "worker.first_ai_call_ms",
              value: firstAiCallMs,
              properties: { runId, workerType },
            });
          }
          // Forward subprocess logs to App Insights. These are debug-level, so
          // trackTrace only forwards them when TELEMETRY_LOG_LEVEL=Verbose.
          trackTrace({
            message: msg,
            severityLevel: "Verbose",
            properties: { runId, workerType },
          });
          await log("debug", msg);
        },
        mcpServers: [],
        sessionTimeoutMs: process.env.ACP_SESSION_TIMEOUT_MS ? Number(process.env.ACP_SESSION_TIMEOUT_MS) : undefined,
        model: options?.model,
        reasoningEffort: options?.reasoningEffort,
      });

      await log("info", "Copilot processing complete", {
        stopReason: result.stopReason,
        responseLength: result.response.length
      });

      // Track run duration
      const runDurationMs = Date.now() - runStartTime;
      trackMetric({
        name: "worker.run_duration_ms",
        value: runDurationMs,
        properties: { runId, workerType, stopReason: result.stopReason },
      });

      // Track cold start (first run only — container uptime up to first completed run)
      if (!CopilotProcessor.coldStartTracked) {
        CopilotProcessor.coldStartTracked = true;
        trackMetric({
          name: "worker.cold_start_ms",
          value: process.uptime() * 1000,
          properties: { workerType },
        });
      }

      // Track subprocess idle time (max gap between protocol events)
      const subprocessIdleS = (Date.now() - lastProtocolEventTime) / 1000;
      trackMetric({
        name: "worker.subprocess_idle_s",
        value: subprocessIdleS,
        properties: { runId, workerType },
      });

      clearInterval(idleMonitor);
      const response = result.response || `[${this.workerName}] No response from Copilot`;
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
      clearInterval(idleMonitor);
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
      await log("error", `Copilot processing failed: ${errorMessage}`);
      throw error;
    }
  }
}

/** Start the queue processor with environment-derived storage, Redis and API settings. */
export async function startCopilotWorker(runtime: CopilotWorkerRuntime = {}): Promise<void> {
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
      : process.env.QUEUE_NAME || process.env.AZURE_STORAGE_QUEUE_NAME || "queue-coder-acp-copilot",
    batchSize: parseInt(process.env.BATCH_SIZE || "1", 10),
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "1000", 10),
    redisHost: process.env.REDIS_HOST || "",
    redisPort: parseInt(process.env.REDIS_PORT || "6379", 10),
    redisPassword: process.env.REDIS_PASSWORD || "",
    apiBaseUrl: process.env.SCOPE_MT_API_URL,
    tokenManagerUrl: process.env.TOKEN_MANAGER_URL,
    postProcessorQueueName: process.env.QUEUE_NAME_POST_PROCESSOR || "post-processor-queue",
  };

  const processor = new CopilotProcessor(runtime);
  const queueProcessor = new CodingAgentQueueProcessor(config, processor);

  await queueProcessor.start();
}
