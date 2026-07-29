// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * ProxyClient — adapter interface for proxy backends.
 *
 * Workers code against this interface. The factory in index.ts wraps
 * DevProxyClient (unchanged from main) or returns GatewayClient directly.
 */

import { writeFile, readFile, access } from "node:fs/promises";
import type { WorkerLogFn } from "@scope/core";
import type { HarCollectionResult } from "@scope/platform";

export type { HarCollectionResult };
export { extractHarMetadata } from "@scope/platform";

const POLL_INTERVAL_MS = 500;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Common proxy adapter interface used by workers.
 */
export interface ProxyClient {
  /** Which backend this client talks to. */
  readonly backend: string;
  /** The base API URL for the proxy. */
  readonly apiUrl: string;

  /** Wait for the proxy to become ready. */
  waitForReady(timeoutMs?: number): Promise<void>;

  /** Download the CA certificate and write it to disk. */
  downloadCertificate(outputPath: string): Promise<void>;

  /** Create a combined CA bundle (system + proxy cert). */
  createCombinedCaBundle(proxyCertPath: string, outputPath: string): Promise<string>;

  /** Start recording / session. */
  startRecording(): Promise<void>;

  /**
   * The proxy URL to use for HTTP_PROXY / HTTPS_PROXY.
   * For the gateway backend, this includes the session ID in the userinfo field
   * after startRecording() is called (e.g. `http://<sessionId>@host:port`).
   * For other backends, returns the base apiUrl.
   */
  readonly proxyUrl: string;

  /** Stop recording / session, collect HAR, extract metadata. */
  stopAndCollectHar(log: WorkerLogFn): Promise<HarCollectionResult>;

  /**
   * Collect HAR for a specific iteration without destroying the session.
   * Rotates the iteration counter so subsequent exchanges go to a new file.
   * Only supported by the gateway backend; other backends should throw.
   */
  collectHar(iteration: number, log: WorkerLogFn): Promise<HarCollectionResult>;
}

/**
 * Check whether proxy integration is enabled via environment variable.
 */
export function isProxyEnabled(): boolean {
  return !!process.env.DEV_PROXY_ENABLED;
}

// =============================================================================
// Shared helpers used by both DevProxyClient and GatewayClient
// =============================================================================

export async function waitForProxyReady(
  apiUrl: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiUrl}/health`);
      if (response.ok) return;
    } catch {
      // Not ready yet
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Proxy did not become ready within ${timeoutMs}ms at ${apiUrl}`);
}

export async function downloadProxyCertificate(
  apiUrl: string,
  outputPath: string,
): Promise<void> {
  try {
    await access(outputPath);
    return; // Already exists
  } catch {
    // Download it
  }

  const response = await fetch(`${apiUrl}/api/v1/cacert`);
  if (!response.ok) {
    throw new Error(`Failed to download certificate: ${response.status} ${response.statusText}`);
  }
  const certData = await response.text();
  await writeFile(outputPath, certData, "utf-8");
}

export async function createCombinedCaBundle(
  proxyCertPath: string,
  outputPath: string,
): Promise<string> {
  try {
    await access(outputPath);
    return outputPath; // Already exists
  } catch {
    // Create it
  }

  const proxyCert = await readFile(proxyCertPath, "utf-8");

  const systemCaBundlePaths = [
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/pki/tls/certs/ca-bundle.crt",
    "/etc/ssl/ca-bundle.pem",
    "/etc/ssl/cert.pem",
  ];

  let systemCerts = "";
  for (const bundlePath of systemCaBundlePaths) {
    try {
      systemCerts = await readFile(bundlePath, "utf-8");
      break;
    } catch {
      // Try next
    }
  }

  const combined = systemCerts
    ? `${systemCerts.trimEnd()}\n${proxyCert}`
    : proxyCert;

  await writeFile(outputPath, combined, "utf-8");
  return outputPath;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
