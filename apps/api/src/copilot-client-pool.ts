// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  CopilotClient,
  type CopilotSession,
  type PermissionHandler,
} from "@github/copilot-sdk";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "tarn";
import { TokenManagerClient, withRetry } from "shared";

const DEFAULT_POOL_SIZE = 2;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 30_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

interface CopilotPoolResource {
  client: CopilotClient;
  rootDirectory: string;
  defaultModel: string;
  healthy: boolean;
  destroyed: boolean;
}

export interface CopilotPoolStats {
  used: number;
  free: number;
  pendingAcquires: number;
  pendingCreates: number;
  resources: number;
  resourcesCreated: number;
  sessionsCreated: number;
  sessionsDeleted: number;
}

export interface CopilotCompletionRequest {
  systemPrompt: string;
  userPrompt: string;
  model?: string;
}

export class CopilotCredentialUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CopilotCredentialUnavailableError";
  }
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  console.warn(`[portal-copilot] ignoring invalid ${name}=${JSON.stringify(raw)}`);
  return fallback;
}

function sanitizedRuntimeEnv(): Record<string, string | undefined> {
  const allowed = [
    "PATH",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ] as const;

  const env: Record<string, string | undefined> = {};
  for (const name of allowed) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  const causeText =
    cause && typeof cause === "object"
      ? `${"message" in cause ? String(cause.message) : ""} ${"code" in cause ? String(cause.code) : ""}`
      : "";
  return `${error.message} ${causeText}`.trim();
}

function isRetryableCopilotError(error: unknown): boolean {
  if (error instanceof CopilotCredentialUnavailableError) return false;
  const text = errorText(error).toLowerCase();
  if (
    text.includes("authentication") ||
    text.includes("unauthorized") ||
    text.includes("forbidden") ||
    text.includes("invalid token") ||
    text.includes("protocol version mismatch")
  ) {
    return false;
  }
  return [
    "timeout",
    "timed out",
    "aborted",
    "fetch failed",
    "econnreset",
    "econnrefused",
    "etimedout",
    "socket hang up",
    "rate limit",
    "too many requests",
    "http 429",
    "http 500",
    "http 502",
    "http 503",
    "http 504",
  ].some((pattern) => text.includes(pattern));
}

function isCopilotCredentialFailure(error: unknown): boolean {
  const text = errorText(error).toLowerCase();
  return [
    "authentication",
    "unauthorized",
    "forbidden",
    "invalid token",
    "not entitled",
    "copilot license",
    "no available models",
  ].some((pattern) => text.includes(pattern));
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

const denyPermissions: PermissionHandler = () => ({
  kind: "reject",
  feedback: "Portal AI completions do not permit tool execution.",
});

export class PortalCopilotClientPool {
  private readonly tokenClient: TokenManagerClient;
  private readonly resources = new Set<CopilotPoolResource>();
  private readonly pool: Pool<CopilotPoolResource>;
  private readonly requestTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private resourcesCreated = 0;
  private sessionsCreated = 0;
  private sessionsDeleted = 0;
  private shuttingDown = false;

  constructor(tokenClient = new TokenManagerClient()) {
    this.tokenClient = tokenClient;
    const max = positiveInt("PORTAL_COPILOT_POOL_SIZE", DEFAULT_POOL_SIZE);
    const acquireTimeoutMillis = positiveInt(
      "PORTAL_COPILOT_ACQUIRE_TIMEOUT_MS",
      DEFAULT_ACQUIRE_TIMEOUT_MS,
    );
    this.startupTimeoutMs = positiveInt(
      "PORTAL_COPILOT_STARTUP_TIMEOUT_MS",
      DEFAULT_STARTUP_TIMEOUT_MS,
    );
    this.requestTimeoutMs = positiveInt(
      "PORTAL_COPILOT_REQUEST_TIMEOUT_MS",
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    this.shutdownTimeoutMs = positiveInt(
      "PORTAL_COPILOT_SHUTDOWN_TIMEOUT_MS",
      DEFAULT_SHUTDOWN_TIMEOUT_MS,
    );

    this.pool = new Pool<CopilotPoolResource>({
      min: 0,
      max,
      acquireTimeoutMillis,
      // createResource owns the startup deadline and force-stops a partial
      // client before rejecting. Keep Tarn's outer deadline longer so it never
      // abandons a creator that is still cleaning up and starts a replacement
      // beyond the configured pool maximum.
      createTimeoutMillis:
        this.startupTimeoutMs + this.shutdownTimeoutMs + 1_000,
      destroyTimeoutMillis: this.shutdownTimeoutMs,
      idleTimeoutMillis: positiveInt(
        "PORTAL_COPILOT_IDLE_TIMEOUT_MS",
        DEFAULT_IDLE_TIMEOUT_MS,
      ),
      reapIntervalMillis: 1_000,
      createRetryIntervalMillis: 500,
      propagateCreateError: true,
      create: () => this.createResource(),
      validate: (resource) => resource.healthy && !resource.destroyed,
      destroy: (resource) => this.destroyResource(resource),
      log: (message) => console.warn(`[portal-copilot-pool] ${message}`),
    });

    this.pool.on("createFail", (_eventId, error) => {
      console.warn(`[portal-copilot-pool] create failed: ${errorText(error)}`);
    });
    this.pool.on("acquireFail", (_eventId, error) => {
      console.warn(`[portal-copilot-pool] acquire failed: ${errorText(error)}`);
    });
  }

  stats(): CopilotPoolStats {
    return {
      used: this.pool.numUsed(),
      free: this.pool.numFree(),
      pendingAcquires: this.pool.numPendingAcquires(),
      pendingCreates: this.pool.numPendingCreates(),
      resources: this.resources.size,
      resourcesCreated: this.resourcesCreated,
      sessionsCreated: this.sessionsCreated,
      sessionsDeleted: this.sessionsDeleted,
    };
  }

  async complete(request: CopilotCompletionRequest): Promise<string> {
    if (this.shuttingDown) {
      throw new Error("Copilot SDK pool is shutting down");
    }

    try {
      return await withRetry(
        () => this.completeOnce(request),
        {
          maxRetries: 2,
          baseDelayMs: 500,
          maxDelayMs: 5_000,
          isRetryable: isRetryableCopilotError,
          onRetry: (error: unknown, attempt: number) => {
            console.warn(
              `[portal-copilot] completion attempt ${attempt} failed: ${errorText(error)}`,
            );
          },
        },
      );
    } catch (error) {
      if (error instanceof CopilotCredentialUnavailableError) throw error;
      throw new Error(`Copilot SDK request failed: ${errorText(error)}`, {
        cause: error,
      });
    }
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    try {
      await withTimeout(
        this.pool.destroy(),
        this.shutdownTimeoutMs,
        `Copilot SDK pool did not drain within ${this.shutdownTimeoutMs}ms`,
      );
      console.log("[portal-copilot-pool] shutdown complete");
    } catch (error) {
      console.warn(`[portal-copilot-pool] graceful shutdown failed: ${errorText(error)}`);
      await Promise.allSettled(
        [...this.resources].map((resource) => this.destroyResource(resource, true)),
      );
    }
  }

  private async createResource(): Promise<CopilotPoolResource> {
    let token: string;
    try {
      token = await this.tokenClient.acquireToken("copilot-sdk");
    } catch (error) {
      throw new CopilotCredentialUnavailableError(
        `No Copilot SDK credential is available: ${errorText(error)}`,
        { cause: error },
      );
    }

    const rootDirectory = await mkdtemp(join(tmpdir(), "scope-portal-copilot-"));
    const workingDirectory = join(rootDirectory, "workspace");
    const baseDirectory = join(rootDirectory, "copilot-home");
    await Promise.all([
      mkdir(workingDirectory, { recursive: true }),
      mkdir(baseDirectory, { recursive: true }),
    ]);

    const client = new CopilotClient({
      gitHubToken: token,
      useLoggedInUser: false,
      mode: "empty",
      workingDirectory,
      baseDirectory,
      enableRemoteSessions: false,
      sessionIdleTimeoutSeconds: 60,
      logLevel: "warning",
      env: sanitizedRuntimeEnv(),
    });
    const resource: CopilotPoolResource = {
      client,
      rootDirectory,
      defaultModel: "",
      healthy: true,
      destroyed: false,
    };
    this.resources.add(resource);
    this.resourcesCreated += 1;

    try {
      const models = await withTimeout(
        (async () => {
          await client.start();
          await client.ping("scope-portal-ai-ready");
          return client.listModels();
        })(),
        this.startupTimeoutMs,
        `Copilot CLI startup did not finish within ${this.startupTimeoutMs}ms`,
      );
      const preferred = [
        "gpt-5.4-mini",
        "gpt-5.4",
        "gpt-5.1",
        "gpt-5-mini",
      ];
      resource.defaultModel =
        preferred.find((id) => models.some((model) => model.id === id)) ||
        models[0]?.id ||
        "";
      if (!resource.defaultModel) {
        throw new Error("Copilot SDK returned no available models");
      }
      console.log(
        `[portal-copilot-pool] started pooled Copilot CLI runtime defaultModel=${resource.defaultModel}`,
      );
      return resource;
    } catch (error) {
      resource.healthy = false;
      await this.destroyResource(resource, true);
      if (isCopilotCredentialFailure(error)) {
        throw new CopilotCredentialUnavailableError(
          `Copilot SDK credential cannot provide Portal AI completions: ${errorText(error)}`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  private async completeOnce(request: CopilotCompletionRequest): Promise<string> {
    const pending = this.pool.acquire();
    const resource = await pending.promise;
    let session: CopilotSession | undefined;
    let unsubscribe: (() => void) | undefined;
    let reusable = true;
    let fullResponse = "";

    try {
      session = await resource.client.createSession({
        sessionId: randomUUID(),
        model: request.model || resource.defaultModel,
        streaming: true,
        systemMessage: { mode: "replace", content: request.systemPrompt },
        availableTools: [],
        excludedTools: ["builtin:*", "mcp:*"],
        tools: [],
        mcpServers: {},
        skillDirectories: [],
        customAgents: [],
        enableConfigDiscovery: false,
        skipCustomInstructions: true,
        requestCanvasRenderer: false,
        requestExtensions: false,
        enableMcpApps: false,
        enableSessionTelemetry: false,
        includeSubAgentStreamingEvents: false,
        mcpOAuthTokenStorage: "in-memory",
        onPermissionRequest: denyPermissions,
      });
      this.sessionsCreated += 1;

      unsubscribe = session.on("assistant.message_delta", (event) => {
        fullResponse += event.data.deltaContent;
      });

      const response = await session.sendAndWait(
        { prompt: request.userPrompt },
        this.requestTimeoutMs,
      );
      const content = fullResponse.trim() || response?.data.content?.trim() || "";
      if (!content) {
        throw new Error("Copilot SDK returned an empty response");
      }
      return content;
    } catch (error) {
      reusable = !(
        errorText(error).toLowerCase().includes("authentication") ||
        errorText(error).toLowerCase().includes("protocol") ||
        errorText(error).toLowerCase().includes("connection") ||
        errorText(error).toLowerCase().includes("process exited")
      );
      if (session && errorText(error).toLowerCase().includes("timeout")) {
        await withTimeout(
          session.abort(),
          5_000,
          "Copilot session abort timed out",
        ).catch(() => undefined);
      }
      throw error;
    } finally {
      unsubscribe?.();

      if (session) {
        try {
          await withTimeout(
            session.disconnect(),
            this.shutdownTimeoutMs,
            "Copilot session disconnect timed out",
          );
          await withTimeout(
            resource.client.deleteSession(session.sessionId),
            this.shutdownTimeoutMs,
            "Copilot session deletion timed out",
          );
          this.sessionsDeleted += 1;
        } catch (error) {
          reusable = false;
          console.warn(`[portal-copilot] session cleanup failed: ${errorText(error)}`);
        }
      }

      if (reusable) {
        try {
          await withTimeout(
            resource.client.ping("scope-portal-ai-health"),
            5_000,
            "Copilot CLI health check timed out",
          );
        } catch (error) {
          reusable = false;
          console.warn(`[portal-copilot] health check failed: ${errorText(error)}`);
        }
      }

      if (reusable) {
        this.pool.release(resource);
      } else {
        resource.healthy = false;
        await this.destroyResource(resource, true);
        this.pool.release(resource);
      }
    }
  }

  private async destroyResource(
    resource: CopilotPoolResource,
    force = false,
  ): Promise<void> {
    if (resource.destroyed) return;
    resource.destroyed = true;
    resource.healthy = false;

    try {
      if (force) {
        await withTimeout(
          resource.client.forceStop(),
          this.shutdownTimeoutMs,
          `Copilot CLI force-stop did not finish within ${this.shutdownTimeoutMs}ms`,
        ).catch((error) => {
          console.warn(`[portal-copilot-pool] force-stop failed: ${errorText(error)}`);
        });
      } else {
        const errors = await withTimeout(
          resource.client.stop(),
          this.shutdownTimeoutMs,
          `Copilot CLI did not stop within ${this.shutdownTimeoutMs}ms`,
        );
        if (errors.length > 0) {
          console.warn(
            `[portal-copilot-pool] client stopped with ${errors.length} cleanup error(s)`,
          );
        }
      }
    } catch (error) {
      console.warn(`[portal-copilot-pool] stop failed: ${errorText(error)}`);
      await withTimeout(
        resource.client.forceStop(),
        this.shutdownTimeoutMs,
        `Copilot CLI force-stop did not finish within ${this.shutdownTimeoutMs}ms`,
      ).catch(() => undefined);
    } finally {
      await rm(resource.rootDirectory, { recursive: true, force: true }).catch((error) => {
        console.warn(`[portal-copilot-pool] temp cleanup failed: ${errorText(error)}`);
      });
      this.resources.delete(resource);
    }
  }
}

let sharedPool: PortalCopilotClientPool | undefined;

export function getPortalCopilotClientPool(): PortalCopilotClientPool {
  sharedPool ??= new PortalCopilotClientPool();
  return sharedPool;
}

export async function shutdownPortalCopilotClientPool(): Promise<void> {
  const pool = sharedPool;
  sharedPool = undefined;
  await pool?.shutdown();
}

/** @internal */
export function setPortalCopilotClientPoolForTests(
  pool: PortalCopilotClientPool | undefined,
): void {
  sharedPool = pool;
}
