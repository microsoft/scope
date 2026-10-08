// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { CodingAgentQueueProcessor, WorkerProcessor, WorkerProcessorOptions, WorkerResult, QueueProcessorConfig, LogEvent, WorkerLogFn, TokenManagerClient, createProxyClient, isProxyEnabled, type ProxyClient, createFreshWorkspace, cleanupWorkspaces } from "shared";
import { initTelemetry, trackMetric, trackTrace, trackEvent } from "telemetry";
import { runACPSession } from "./acp-client.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dotenv from "dotenv";

dotenv.config();

// Initialize telemetry before any other setup
initTelemetry(process.env.WORKER_NAME || "coder-acp-copilot-windows");

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
      const parsed = JSON.parse(trimmed);
      return typeof parsed === "object" && parsed !== null && typeof parsed.type === "string";
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Build the environment variables for the copilot subprocess on Windows.
 *
 * When the gateway proxy is active, configures proxy-related env vars so the
 * subprocess routes traffic through the gateway MITM proxy for HAR capture.
 * When proxy is disabled (or setup failed), strips proxy env vars.
 */
export function buildSubprocessEnv(
  githubToken: string,
  proxyEnabled: boolean,
  currentNodeOptions?: string,
  gatewayUrl?: string,
  proxyUrl?: string,
  certPath?: string,
): Record<string, string> {
  const gatewayHost = gatewayUrl ? new URL(gatewayUrl).hostname : null;
  const noProxy = [
    "localhost",
    "127.0.0.1",
    // Exclude auth endpoints to avoid intercepting initial auth flow
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
    ...(proxyEnabled ? {
      // Node.js 22.21+ supports --use-env-proxy in NODE_OPTIONS, which makes
      // undici/fetch route through HTTP_PROXY env vars.
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

const WORKER_NAME = process.env.WORKER_NAME || "coder-acp-copilot-windows";
const tokenClient = new TokenManagerClient();
const AGENT_VERSION =
  process.env.SCOPE_AGENT_VERSION ||
  `copilot-${process.env.COPILOT_CLI_VERSION || "unknown"}`;

class CopilotWindowsProcessor implements WorkerProcessor {
  static coldStartTracked = false;
  readonly workerName = WORKER_NAME;
  readonly skillAgentType = "copilot" as const;
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
    const runStartTime = Date.now();
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const workerType = WORKER_NAME;
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

    await log("info", "Starting Copilot ACP processor (Windows)", {
      inputLength: message.length,
      model: options?.model,
    });

    trackEvent({
      name: "worker.run_started",
      properties: { runId, workerType, model: options?.model || "default" },
    });

    // Proxy integration — start recording if enabled (gateway backend only)
    let devProxy: ProxyClient | null = null;
    let certPath: string | undefined;
    if (isProxyEnabled()) {
      const proxy = createProxyClient();
      try {
        await log("info", `Proxy enabled [${proxy.backend}] — waiting for gateway to be ready...`);
        await proxy.waitForReady();
        // Download CA cert to temp dir (avoids certutil.exe which caused crashes)
        certPath = join(tmpdir(), "gateway-ca.crt");
        await proxy.downloadCertificate(certPath);
        // Create combined CA bundle for NODE_EXTRA_CA_CERTS
        const bundlePath = join(tmpdir(), "ca-bundle-combined.crt");
        certPath = await proxy.createCombinedCaBundle(certPath, bundlePath);
        await log("info", "Gateway CA cert downloaded", { certPath });
        await proxy.startRecording();
        devProxy = proxy;
        await log("info", `Proxy recording started [${proxy.backend}]`, { proxyUrl: proxy.proxyUrl });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        await log("warn", `Gateway proxy setup failed, continuing without HAR capture: ${msg}`);
        devProxy = null;
        certPath = undefined;
      }
    }

    try {
      const githubToken = await tokenClient.acquireToken("copilot-sdk");
      await log("info", "Acquired GITHUB_TOKEN", {
        preview: `${githubToken.substring(0, 7)}...(${githubToken.length} chars)`,
      });

      // --no-auto-update prevents the CLI from self-updating mid-session (see #1179).
      const args = ["--acp", "--yolo", "--no-auto-update"];
      if (options?.model) {
        args.push("--model", options.model);
      }

      const result = await runACPSession(message, {
        command: "copilot",
        args,
        env: buildSubprocessEnv(
          githubToken,
          !!devProxy,
          process.env.NODE_OPTIONS,
          process.env.DEV_PROXY_API_URL,
          devProxy?.proxyUrl,
          certPath,
        ),
        cwd: this.workspacePath!,
        // Use shell: true on Windows so spawn resolves .cmd shims (e.g. copilot.cmd)
        shell: true,
        onLog: async (msg: string) => {
          lastProtocolEventTime = Date.now();
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
        model: options?.model,
      });

      await log("info", "Copilot processing complete", {
        stopReason: result.stopReason,
        responseLength: result.response.length,
      });

      // Track run duration
      const runDurationMs = Date.now() - runStartTime;
      trackMetric({
        name: "worker.run_duration_ms",
        value: runDurationMs,
        properties: { runId, workerType, stopReason: result.stopReason },
      });

      // Track cold start (first run only — container uptime up to first completed run)
      if (!CopilotWindowsProcessor.coldStartTracked) {
        CopilotWindowsProcessor.coldStartTracked = true;
        trackMetric({
          name: "worker.cold_start_ms",
          value: process.uptime() * 1000,
          properties: { workerType },
        });
      }

      // Track subprocess idle time
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
      return { response, ...(harFilePath && { harFilePath }), ...(tokenUsage && { tokenUsage }), ...(aiCallCount !== undefined && { aiCallCount }) };
    } catch (error) {
      clearInterval(idleMonitor);
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
