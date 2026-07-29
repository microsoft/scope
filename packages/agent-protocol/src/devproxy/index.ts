// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export { DevProxyClient } from "./devproxy-client.js";
export type { DevProxyInfo } from "./devproxy-client.js";
export { GatewayClient } from "./gateway-client.js";
export type { ProxyClient, HarCollectionResult } from "./proxy-client.js";
export { isProxyEnabled } from "./proxy-client.js";

import { DevProxyClient } from "./devproxy-client.js";
import { GatewayClient } from "./gateway-client.js";
import { parseHarFile } from "@scope/platform";
import type { ProxyClient } from "./proxy-client.js";
import { extractHarMetadata } from "@scope/platform";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const DEFAULT_API_URL = "http://localhost:18000";

/**
 * Create the appropriate proxy client based on PROXY_BACKEND env var.
 *
 * Both backends are wrapped in a thin adapter that satisfies ProxyClient.
 * Clients handle proxy lifecycle; the adapter composes HAR collection.
 */
export function createProxyClient(): ProxyClient {
  const backend = process.env.PROXY_BACKEND || "devproxy";
  const apiUrl = process.env.DEV_PROXY_API_URL || DEFAULT_API_URL;

  if (backend === "gateway") {
    const gw = new GatewayClient(apiUrl);
    return {
      backend: "gateway",
      apiUrl: gw.apiUrl,
      get proxyUrl() { return gw.proxyUrl; },
      waitForReady: (t) => gw.waitForReady(t),
      downloadCertificate: (p) => gw.downloadCertificate(p),
      createCombinedCaBundle: (c, o) => gw.createCombinedCaBundle(c, o),
      startRecording: async () => {
        const maxSessionDurationSecs = parseInt(process.env.COPILOT_MAX_SESSION_DURATION_SECS || "3600", 10);
        const plugins: Record<string, unknown> = {};

        // Enable the copilot_token auto-refresh plugin when TOKEN_MANAGER_URL is set.
        // tokenManagerUrl is configured at gateway level; here we only pass per-session
        // settings (capability, refresh window, target hosts, max duration).
        const tokenManagerUrl = process.env.TOKEN_MANAGER_URL;
        if (tokenManagerUrl) {
          plugins.copilot_token = {
            capability: process.env.COPILOT_TOKEN_CAPABILITY || "generic",
            refreshBufferSecs: 120,
            maxSessionDurationSecs,
            targetHosts: [
              "api.githubcopilot.com",
              "api.enterprise.githubcopilot.com",
              "copilot-proxy.githubusercontent.com",
            ],
          };
        }

        await gw.startSession(plugins, maxSessionDurationSecs);
      },
      stopAndCollectHar: async (log) => {
        try {
          await gw.stopSession();
          await log("info", "Gateway session stopped");
          const har = await gw.downloadHar(1);
          if (har) {
            // Write HAR to temp file so the upload pipeline can pick it up
            const harFilePath = join(tmpdir(), `gateway-${Date.now()}.har`);
            await writeFile(harFilePath, JSON.stringify(har), "utf-8");
            const result = extractHarMetadata(har, harFilePath, log);
            // Clean up session on the gateway after collecting data
            try { await gw.deleteSession(); } catch { /* best effort */ }
            return result;
          }
          await log("warn", "No HAR data returned from gateway");
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          await log("warn", `Gateway HAR collection failed (session may have been lost due to a gateway restart): ${msg}`);
        }
        // Best-effort cleanup even on failure
        try { await gw.deleteSession(); } catch { /* best effort */ }
        return { harFilePath: null };
      },
      collectHar: async (iteration, log) => {
        try {
          const har = await gw.downloadHar(iteration);
          if (har) {
            const harFilePath = join(tmpdir(), `gateway-iter${iteration}-${Date.now()}.har`);
            await writeFile(harFilePath, JSON.stringify(har), "utf-8");
            await log("info", `Downloaded HAR for iteration ${iteration}`);
            // Rotate so subsequent exchanges go to iteration+1
            const newIter = await gw.rotateHar(iteration);
            await log("info", `Rotated HAR to iteration ${newIter}`);
            return extractHarMetadata(har, harFilePath, log);
          }
          await log("warn", `No HAR data returned from gateway for iteration ${iteration}`);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          await log("warn", `Gateway HAR collection for iteration ${iteration} failed: ${msg}`);
        }
        return { harFilePath: null };
      },
    };
  }

  const dp = new DevProxyClient(apiUrl);
  // DevProxy listens on two distinct ports: a management API (default 18897,
  // exposed via DEV_PROXY_API_URL) and the actual MITM proxy (default 18000,
  // set via DEV_PROXY_URL in compose). Earlier versions of this adapter
  // returned `apiUrl` here, which pointed worker subprocesses at the
  // management port and made every HTTPS request fail with
  // "Authentication required". Require DEV_PROXY_URL to be set explicitly
  // so any future drift is caught loudly at startup rather than silently
  // mis-routing traffic.
  const proxyUrl = process.env.DEV_PROXY_URL;
  if (!proxyUrl) {
    throw new Error(
      "DEV_PROXY_URL must be set when the devproxy backend is selected. " +
      "Set it to the proxy port (default 18000), distinct from DEV_PROXY_API_URL (18897)."
    );
  }
  return {
    backend: "devproxy",
    apiUrl,
    proxyUrl,
    waitForReady: (t) => dp.waitForReady(t),
    downloadCertificate: (p) => dp.downloadCertificate(p),
    createCombinedCaBundle: (c, o) => dp.createCombinedCaBundle(c, o),
    startRecording: () => dp.startRecording(),
    stopAndCollectHar: async (log) => {
      try {
        await dp.stopRecording();
        await log("info", "DevProxy recording stopped");
        const harFilePath = await dp.getLatestHarFile();
        if (harFilePath) {
          const har = await parseHarFile(harFilePath);
          return extractHarMetadata(har, harFilePath, log);
        }
        await log("warn", "No HAR file found after DevProxy recording");
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        await log("warn", `Gateway HAR collection failed (session may have been lost due to a gateway restart): ${msg}`);
      }
      return { harFilePath: null };
    },
    collectHar: async () => {
      throw new Error("collectHar() is not supported by the devproxy backend");
    },
  };
}
