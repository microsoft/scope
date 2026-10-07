// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import { GatewayClient } from "shared";
import type { FetchFn } from "./scan.js";

/**
 * Whether the scan should go through a gateway session with CAPI HMAC
 * (integration) auth. Mirrors the worker opt-in: the HMAC secret and
 * integration ID live only in the gateway, never in this process.
 */
export function isCapiHmacEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GATEWAY_CAPI_HMAC_ENABLED === "true";
}

/** The gateway resolves the session from `Proxy-Authorization: Basic base64(<sessionId>:)`. */
export function proxyAuthorizationFor(sessionId: string): string {
  return `Basic ${Buffer.from(`${sessionId}:`).toString("base64")}`;
}

const SESSION_MAX_DURATION_SECS = 300;

/**
 * Run `fn` with a fetch that tunnels through a short-lived gateway session
 * opted into the `capi_hmac` plugin. The gateway strips `Authorization`,
 * sets the integration ID and signs CAPI requests, so callers need no token.
 */
export async function withCapiGatewayFetch<T>(
  fn: (fetchFn: FetchFn) => Promise<T>,
  apiUrl: string | undefined = process.env.DEV_PROXY_API_URL,
): Promise<T> {
  if (!apiUrl) {
    throw new Error(
      "GATEWAY_CAPI_HMAC_ENABLED=true requires DEV_PROXY_API_URL to point at the gateway",
    );
  }

  const gateway = new GatewayClient(apiUrl);
  await gateway.waitForReady();

  const certDir = await mkdtemp(join(tmpdir(), "scanner-gateway-"));
  let agent: ProxyAgent | undefined;
  try {
    const certPath = join(certDir, "gateway-ca.pem");
    await gateway.downloadCertificate(certPath);
    const gatewayCa = await readFile(certPath, "utf-8");

    // A catalog lookup isn't agent traffic, so skip HAR recording.
    const sessionId = await gateway.startSession(
      { capi_hmac: { enabled: true }, har: { enabled: false } },
      SESSION_MAX_DURATION_SECS,
    );
    agent = new ProxyAgent({
      uri: apiUrl,
      token: proxyAuthorizationFor(sessionId),
      requestTls: { ca: [...rootCertificates, gatewayCa] },
    });
    const dispatcher = agent;
    const fetchFn: FetchFn = (input, init) =>
      undiciFetch(input, {
        ...(init as Parameters<typeof undiciFetch>[1]),
        dispatcher,
      }) as unknown as Promise<Response>;

    return await fn(fetchFn);
  } finally {
    await agent?.close().catch(() => {});
    try {
      await gateway.stopSession();
      await gateway.deleteSession();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`Gateway session cleanup failed (session will expire): ${msg}`);
    }
    await rm(certDir, { recursive: true, force: true });
  }
}
