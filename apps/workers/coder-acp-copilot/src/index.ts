// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { CodingAgentQueueProcessor, WorkerProcessor, WorkerProcessorOptions, WorkerResult, QueueProcessorConfig, LogEvent, WorkerLogFn, TokenManagerClient, createProxyClient, isProxyEnabled, type ProxyClient, McpGatewayClient, McpServerConfig, KubedockClient, createFreshWorkspace, cleanupWorkspaces, type ResourceConfig, type ResourceRunOutcome, runResourceSetups, runResourceTeardowns, createConcealedStore, interpolateMcpServerConfigs, referencedPlaceholders } from "shared";
import { initTelemetry, trackMetric, trackTrace, trackEvent } from "telemetry";
import { runACPSession } from "./acp-client.js";
import { access, constants as fsConstants } from "node:fs/promises";
import dotenv from "dotenv";

dotenv.config();

// Initialize telemetry before any other setup
initTelemetry(process.env.WORKER_NAME || "coder-acp-copilot");

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
/**
 * Reject a key published to both the public and the concealed channel.
 *
 * The two channels mean opposite things about agent visibility, so a key in both
 * has no sensible resolution: the concealed value would win for MCP
 * interpolation, the public value would be silently discarded, and the key would
 * be withheld from the agent entirely. That is a security-sensitive ambiguity, so
 * it fails the run instead of being resolved silently.
 *
 * @throws if any key appears in both maps.
 */
export function assertNoPublishChannelCollision(
  values: Record<string, string>,
  concealed: Record<string, string>,
): void {
  const collisions = Object.keys(concealed).filter((key) => key in values);
  if (collisions.length > 0) {
    throw new Error(
      `Resource setup published the same key to both the public and concealed channels: ${collisions.sort().join(", ")}. `
      + "Publish each key to exactly one of $SCOPE_SETUP_ENV or $SCOPE_CONCEALED_ENV."
    );
  }
}

export function buildSubprocessEnv(  githubToken: string,
  devProxyEnabled: boolean,
  currentNodeOptions?: string,
  gatewayUrl?: string,
  proxyUrl?: string,
  certPath?: string,
  resourceEnv?: Record<string, string>,
  concealedNames?: string[],
): Record<string, string> {
  const gatewayHost = gatewayUrl ? new URL(gatewayUrl).hostname : null;
  // Values a resource published to the concealed store are for the platform and
  // for tooling wrappers, not for the agent. They stay in `resourceEnv` because
  // MCP server interpolation needs them; this is where they stop.
  const visibleResourceEnv = Object.fromEntries(
    Object.entries(resourceEnv ?? {}).filter(([name]) => !(concealedNames ?? []).includes(name)),
  );
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
    // Connection details published by the run's resources. This is the only way
    // an agent-facing tool can learn where its resources live: every other key
    // here is fixed, and process.env is deliberately not spread.
    //
    // Spread FIRST so the fixed keys below win. A resource must not be able to
    // shadow GITHUB_TOKEN — that is the CLI's own auth, not the simulator's —
    // nor the proxy settings, which are what route model traffic for capture.
    ...visibleResourceEnv,
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
const tokenClient = new TokenManagerClient();
const AGENT_VERSION =
  process.env.SCOPE_AGENT_VERSION ||
  `copilot-${process.env.COPILOT_CLI_VERSION || "unknown"}`;

class CopilotProcessor implements WorkerProcessor {
  static coldStartTracked = false;
  readonly workerName = WORKER_NAME;
  readonly skillAgentType = "copilot" as const;
  workspacePath: string | undefined = undefined;
  private gateway: McpGatewayClient | null = null;
  private mcpConfigs: McpServerConfig[] = [];
  private kubedock: KubedockClient | null = null;
  private resourceConfigs: ResourceConfig[] = [];
  /** Resources actually brought up this run, for reverse-order release. */
  private provisionedResources: ResourceConfig[] = [];
  /** Connection details published by this run's resources. */
  private resourceEnv: Record<string, string> = {};
  /**
   * Names published to the concealed store rather than to `$SCOPE_SETUP_ENV`.
   * They stay in `resourceEnv` because MCP server interpolation needs them, and
   * are subtracted when the agent's environment is built.
   */
  private concealedNames: string[] = [];
  /** Run-scoped concealed store; must outlive setup, since the agent runs after it. */
  private concealedStore: { path: string; dispose: () => Promise<void> } | null = null;
  /** Per-resource lifecycle outcomes, surfaced on the run record. */
  private resourceOutcomes: ResourceRunOutcome[] = [];
  /** Whether MCP servers were actually registered with the gateway. */
  private mcpRegistered = false;

  /** Lifecycle observability for the run record, read after setup/teardown. */
  getRunObservations(): { resources: ResourceRunOutcome[]; mcpRegistered: boolean } {
    return { resources: this.resourceOutcomes, mcpRegistered: this.mcpRegistered };
  }

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

    // Purge orphan containers from previous runs (crash recovery).
    //
    // This must stay BEFORE resource setup: a resource that publishes a fixed
    // port cannot start if a container from an earlier run is still holding it.
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
    this.resourceConfigs = options?.resourceConfigs ?? [];
    // Reset per-run observations here rather than in teardown. The processor
    // instance is reused across messages, and teardown cleared mcpConfigs but
    // left mcpRegistered set -- so once any run registered a server, every later
    // run on the same worker reported mcpRegistered: true regardless of its own
    // configuration. Registration itself was correctly skipped, so this was a
    // false report rather than a leak of tools, which makes it worse: the field
    // exists precisely to show which surface a run was given.
    this.mcpRegistered = false;
    this.resourceOutcomes = [];
    this.resourceEnv = {};
    this.concealedNames = [];

    // Provision resources before registering MCP servers. This ordering is the
    // whole point of the feature: registration opens a live connection to the
    // server and throws if it is unreachable, so anything the run needs to talk
    // to has to exist first.
    if (this.resourceConfigs.length > 0) {
      await this.preflightDockerSocket(log);
      this.concealedStore = await createConcealedStore();
      try {
        const { values, concealed, provisioned } = await runResourceSetups(this.resourceConfigs, {
          cwd: this.workspacePath,
          env: { ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}) },
          log: (level, message) => void log(level, message),
          concealedEnvPath: this.concealedStore?.path,
          // Tracked as each resource is attempted, not from the returned list: a
          // setup that throws never returns, and releaseResources() would then
          // find an empty list and tear down nothing — including the failing
          // resource, whose script may already have created containers.
          onProvisioned: (resource) => {
            this.provisionedResources = [...this.provisionedResources, resource];
          },
        });
        this.provisionedResources = provisioned;
        assertNoPublishChannelCollision(values, concealed);
        // Concealed values join resourceEnv so MCP server interpolation keeps
        // working; they are subtracted again when the agent's env is built.
        this.resourceEnv = { ...values, ...concealed };
        this.concealedNames = Object.keys(concealed);
        this.resourceOutcomes = provisioned.map((r) => ({
          ref: r.ref,
          slug: r.slug,
          revisionId: r.revisionId,
          setupSucceeded: true,
          published: r.exports,
          ...(r.params && Object.keys(r.params).length > 0 ? { params: r.params } : {}),
        }));
        await log("info", "Resources provisioned", {
          count: provisioned.length,
          published: Object.keys(values).sort(),
        });
      } catch (err) {
        // Record what actually happened to each resource, so a failed run still
        // shows the environment it was trying to stand up. The attempted prefix
        // is read before releaseResources() clears it: everything before the last
        // entry was provisioned successfully, the last entry is the one that
        // failed, and anything beyond it was never attempted. Marking all of them
        // failed would misreport both of the other two groups.
        const message = err instanceof Error ? err.message : String(err);
        const attempted = this.provisionedResources;
        const failing = attempted[attempted.length - 1];
        this.resourceOutcomes = this.resourceConfigs
          .filter((r) => attempted.some((a) => a.revisionId === r.revisionId))
          .map((r) => ({
            ref: r.ref,
            slug: r.slug,
            revisionId: r.revisionId,
            setupSucceeded: failing ? r.revisionId !== failing.revisionId : false,
            published: failing && r.revisionId !== failing.revisionId ? r.exports : [],
            ...(r.params && Object.keys(r.params).length > 0 ? { params: r.params } : {}),
            ...(failing && r.revisionId === failing.revisionId ? { error: message } : {}),
          }));
        // Unwind whatever already came up before failing the run; a partially
        // provisioned environment would otherwise leak into the next run.
        await this.releaseResources(log);
        throw err;
      }
    }

    if (this.mcpConfigs.length > 0) {
      if (!McpGatewayClient.isEnabled()) {
        throw new Error("MCP servers configured but MCP_GATEWAY_URL is not set — cannot proceed without gateway");
      }
      // Interpolate AFTER secret hydration (done by the queue processor) and
      // immediately before registration. Hydration replaces the whole env or
      // headers object rather than merging, so substituting any earlier would be
      // silently undone.
      let configs = this.mcpConfigs;
      if (Object.keys(this.resourceEnv).length > 0 || referencedPlaceholders(configs).length > 0) {
        configs = interpolateMcpServerConfigs(configs, this.resourceEnv);
        this.mcpConfigs = configs;
      }
      this.gateway = new McpGatewayClient();
      await log("info", "Registering MCP servers with gateway", { count: configs.length, servers: configs.map((s) => s.name) });
      await this.gateway.purgeAll();
      for (const config of configs) await this.gateway.registerServer(config);
      this.mcpRegistered = true;
    }
  }

  /**
   * Fail early, and legibly, when the Docker socket is unusable.
   *
   * Without this a container-backed resource fails inside its own script with a
   * raw `permission denied ... /var/run/docker.sock`, which reads like a group
   * ownership problem even when it is an SELinux label denial — a genuinely
   * costly thing to misdiagnose.
   */
  private async preflightDockerSocket(log: WorkerLogFn): Promise<void> {
    const dockerHost = process.env.DOCKER_HOST;
    if (!dockerHost) {
      await log("warn", "Resources are configured but DOCKER_HOST is not set — a container-backed resource will fail");
      return;
    }
    const socketPath = dockerHost.startsWith("unix://") ? dockerHost.slice("unix://".length) : null;
    if (!socketPath) return;
    try {
      await access(socketPath, fsConstants.R_OK | fsConstants.W_OK);
      await log("info", "Docker socket is reachable", { dockerHost });
    } catch (err) {
      throw new Error(
        `Docker socket at ${socketPath} is not usable by this worker (${err instanceof Error ? err.message : String(err)}). ` +
          `Resources that start containers cannot run. On a host enforcing SELinux this is usually a label denial rather than ` +
          `a GID problem — the container needs security_opt label=disable in addition to the right group_add.`,
      );
    }
  }

  /** Release provisioned resources in reverse order. Safe to call twice. */
  private async releaseResources(log: WorkerLogFn): Promise<void> {
    if (this.provisionedResources.length === 0) {
      // Setup may have failed before provisioning anything, so the store is
      // still disposed of here rather than only on the happy path.
      await this.concealedStore?.dispose();
      this.concealedStore = null;
      return;
    }
    const toRelease = this.provisionedResources;
    this.provisionedResources = [];
    for (const o of this.resourceOutcomes) {
      if (toRelease.some((r) => r.revisionId === o.revisionId)) o.teardownRan = true;
    }
    try {
      await runResourceTeardowns(toRelease, {
        cwd: this.workspacePath ?? process.cwd(),
        env: { ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}) },
        log: (level, message) => void log(level, message),
        concealedEnvPath: this.concealedStore?.path,
      });
    } finally {
      await this.concealedStore?.dispose();
      this.concealedStore = null;
    }
  }

  async teardown(log: WorkerLogFn): Promise<void> {
    // Release resources BEFORE purging containers. The purge would otherwise
    // destroy the very containers a teardown script is about to remove, leaving
    // it to fail or silently no-op.
    await this.releaseResources(log);

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
    if (isProxyEnabled()) {
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
        const certPath = process.env.NODE_EXTRA_CA_CERTS || "/tmp/dev-proxy-ca.crt";
        await proxy.downloadCertificate(certPath);
        const bundlePath = "/tmp/ca-bundle-combined.crt";
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
      const githubToken = await tokenClient.acquireToken("copilot-cli");
      await log("info", "Acquired GITHUB_TOKEN", {
        preview: `${githubToken.substring(0, 7)}...(${githubToken.length} chars)`,
      });

      // Run ACP session with GitHub Copilot
      // --no-auto-update prevents the CLI from self-updating mid-session (see #1179).
      const args = ["--acp", "--yolo", "--no-auto-update"];
      if (options?.model) {
        args.push("--model", options.model);
      }
      if (options?.reasoningEffort) {
        args.push("--reasoning-effort", options.reasoningEffort);
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
        env: buildSubprocessEnv(githubToken, !!devProxy, process.env.NODE_OPTIONS, process.env.MCP_GATEWAY_URL, devProxy?.proxyUrl, caCertBundlePath, this.resourceEnv, this.concealedNames),
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
