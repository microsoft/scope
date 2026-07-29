// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * GatewayClient — talks to the Rust TLS-intercepting gateway proxy.
 *
 * Uses the RESTful session API:
 *   POST   /api/v1/sessions           → create session (returns { id })
 *   GET    /api/v1/sessions           → list sessions
 *   GET    /api/v1/sessions/:id       → session status
 *   POST   /api/v1/sessions/:id/stop  → stop recording
 *   GET    /api/v1/sessions/:id/har   → download HAR
 *   DELETE /api/v1/sessions/:id       → delete session
 *   GET    /api/v1/cacert             → CA certificate
 *   GET    /health                   → health check
 */

import type { HarFile } from "@scope/platform";
import { withRetry } from "@scope/core";
import {
  waitForProxyReady,
  downloadProxyCertificate,
  createCombinedCaBundle,
} from "./proxy-client.js";

const DEFAULT_API_URL = "http://localhost:18000";

/** Returns true for network errors and 5xx responses (transient). */
function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return true;
  // Network-level failures (fetch failed, ECONNREFUSED, etc.)
  if (err.name === "TypeError") return true;
  const msg = err.message;
  // 5xx server errors
  if (/\b5\d{2}\b/.test(msg)) return true;
  return false;
}

const RETRY_OPTS = {
  maxRetries: 3,
  baseDelayMs: 500,
  isRetryable: isTransientError,
  onRetry: (err: unknown, attempt: number) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[GatewayClient] Attempt ${attempt} failed: ${msg}`);
  },
} as const;

export class GatewayClient {
  readonly apiUrl: string;
  private sessionId: string | null = null;

  constructor(
    apiUrl: string = process.env.DEV_PROXY_API_URL || DEFAULT_API_URL,
  ) {
    this.apiUrl = apiUrl;
  }

  /** The MCP endpoint URL for MCP-aware workers. */
  get mcpEndpoint(): string {
    return `${this.apiUrl}/mcp`;
  }

  /**
   * Proxy URL with the session ID embedded in the userinfo field.
   * HTTP clients will send this as a `Proxy-Authorization: Basic` header,
   * allowing the gateway to resolve the session directly without IP lookup.
   *
   * Returns the bare apiUrl if no session has been started yet.
   */
  get proxyUrl(): string {
    if (!this.sessionId) {
      return this.apiUrl;
    }
    const url = new URL(this.apiUrl);
    url.username = this.sessionId;
    return url.toString().replace(/\/$/, "");
  }

  async waitForReady(timeoutMs?: number): Promise<void> {
    return waitForProxyReady(this.apiUrl, timeoutMs);
  }

  async downloadCertificate(outputPath: string): Promise<void> {
    return downloadProxyCertificate(this.apiUrl, outputPath);
  }

  async createCombinedCaBundle(proxyCertPath: string, outputPath: string): Promise<string> {
    return createCombinedCaBundle(proxyCertPath, outputPath);
  }

  async startSession(plugins: Record<string, unknown> = {}, maxSessionDurationSecs?: number): Promise<string> {
    const id = this.sessionId ?? crypto.randomUUID();
    await withRetry(
      async () => {
        const response = await fetch(`${this.apiUrl}/api/v1/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, plugins, maxSessionDurationSecs }),
        });
        if (!response.ok) {
          throw new Error(`Failed to create gateway session: ${response.status} ${response.statusText}`);
        }
      },
      RETRY_OPTS,
    );
    this.sessionId = id;
    return id;
  }

  async stopSession(): Promise<void> {
    const id = this.requireSessionId();
    await withRetry(
      async () => {
        const response = await fetch(`${this.apiUrl}/api/v1/sessions/${id}/stop`, {
          method: "POST",
        });
        if (!response.ok) {
          throw new Error(`Failed to stop gateway session: ${response.status} ${response.statusText}`);
        }
      },
      RETRY_OPTS,
    );
  }

  async downloadHar(iteration: number): Promise<HarFile | null> {
    const id = this.sessionId;
    if (!id) return null;
    try {
      return await withRetry(
        async () => {
          const response = await fetch(`${this.apiUrl}/api/v1/sessions/${id}/har?iteration=${iteration}`);
          if (!response.ok) {
            throw new Error(`HAR download failed: ${response.status} ${response.statusText}`);
          }
          return (await response.json()) as HarFile;
        },
        { ...RETRY_OPTS, isRetryable: () => true },
      );
    } catch {
      return null;
    }
  }

  /**
   * Rotate the HAR iteration: CAS-guarded bump from `expected` to `expected+1`.
   * Returns the new iteration number on success.
   *
   * Idempotent: if a previous attempt succeeded but the response was lost
   * (network blip), the retry will get a 409 with `iteration === expected+1`,
   * which is treated as success.
   */
  async rotateHar(expected: number): Promise<number> {
    const id = this.requireSessionId();
    return withRetry(
      async () => {
        const response = await fetch(
          `${this.apiUrl}/api/v1/sessions/${id}/rotate?expected=${expected}`,
          { method: "POST" },
        );
        const body = (await response.json()) as { iteration: number };
        if (response.status === 409) {
          // The rotation we requested already happened (lost response on
          // a previous attempt). Treat as idempotent success.
          if (body.iteration === expected + 1) {
            return body.iteration;
          }
          throw new Error(
            `HAR rotate conflict: expected iteration ${expected}, server has ${body.iteration}`,
          );
        }
        if (!response.ok) {
          throw new Error(`HAR rotate failed: ${response.status} ${response.statusText}`);
        }
        return body.iteration;
      },
      RETRY_OPTS,
    );
  }

  async deleteSession(): Promise<void> {
    const id = this.requireSessionId();
    await withRetry(
      async () => {
        const response = await fetch(`${this.apiUrl}/api/v1/sessions/${id}`, {
          method: "DELETE",
        });
        if (!response.ok && response.status !== 404) {
          throw new Error(`Failed to delete gateway session: ${response.status} ${response.statusText}`);
        }
      },
      RETRY_OPTS,
    );
    this.sessionId = null;
  }

  /** Returns the current session ID, or throws if no session has been started. */
  private requireSessionId(): string {
    if (!this.sessionId) {
      throw new Error("No active gateway session — call startSession() first");
    }
    return this.sessionId;
  }
}
