// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import dotenv from "dotenv";
dotenv.config();

import { initTelemetry, trackMetric, trackEvent, shutdownTelemetry } from "telemetry";
import { TokenManagerClient } from "shared";
import {
  parseScannerArgs,
  waitForApi,
  reconcileModels,
  fetchAgentsByProvider,
} from "model-scanning";
import { scanCopilotModels } from "./scan.js";
import { isCapiHmacEnabled, withCapiGatewayFetch } from "./capi-gateway.js";

const PROVIDER = "github-copilot";

async function main(): Promise<void> {
  initTelemetry("scope-model-scanner-copilot");
  const scanStart = Date.now();
  const { dryRun, apiUrl } = parseScannerArgs();

  console.log(`Model scanner: copilot (provider: ${PROVIDER})`);
  console.log(`Mode: ${dryRun ? "dry-run" : "live"}`);

  let scanResult;
  if (isCapiHmacEnabled()) {
    // CAPI HMAC (integration) auth: the gateway signs the request, so the
    // catalog is the integration's rather than a user token's.
    console.log("Scanning GitHub Copilot models via gateway with CAPI HMAC auth...");
    scanResult = await withCapiGatewayFetch((fetchFn) => scanCopilotModels(null, fetchFn));
  } else {
    // Acquire token — must be an OAuth token, not a PAT (Copilot API rejects PATs)
    console.log("Acquiring token for copilot-models capability...");
    const tokenStart = Date.now();
    const token = await new TokenManagerClient().acquireToken("copilot-models");
    trackMetric({ name: "model_scanner.token_acquisition_ms", value: Date.now() - tokenStart, properties: { service: "model-scanner-copilot", provider: PROVIDER } });
    console.log("Token acquired.");

    console.log("Scanning GitHub Copilot models...");
    scanResult = await scanCopilotModels(token);
  }
  console.log(`Found ${scanResult.models.length} models:`);
  for (const model of scanResult.models) {
    console.log(`  - ${model.id}`);
  }

  if (dryRun) {
    // Dry-run: output JSON and exit
    console.log("\n--- Dry-run output ---");
    console.log(JSON.stringify(scanResult, null, 2));
    trackMetric({ name: "model_scanner.scan_duration_ms", value: Date.now() - scanStart, properties: { service: "model-scanner-copilot", provider: PROVIDER } });
    trackMetric({ name: "model_scanner.models_found", value: scanResult.models.length, properties: { service: "model-scanner-copilot", provider: PROVIDER } });
    await shutdownTelemetry();
    process.exit(0);
  }

  // Live mode: wait for API, discover agents, sync models
  console.log(`Waiting for API at ${apiUrl}...`);
  await waitForApi(apiUrl);

  // Discover all agents that declare this model provider
  console.log(`Discovering agents with modelProvider: ${PROVIDER}...`);
  const agents = await fetchAgentsByProvider(apiUrl, PROVIDER);

  if (agents.length === 0) {
    console.warn(`No agents found with modelProvider: ${PROVIDER}. Nothing to sync.`);
    await shutdownTelemetry();
    process.exit(0);
  }

  console.log(`Found ${agents.length} agent(s): ${agents.map((a) => a._id).join(", ")}`);

  // Sync models for each agent
  let totalAdded = 0, totalRemoved = 0, totalUnchanged = 0;
  for (const agent of agents) {
    console.log(`\nSyncing models for agent: ${agent._id}...`);
    const report = await reconcileModels(
      apiUrl,
      agent._id,
      PROVIDER,
      scanResult,
    );
    totalAdded += report.added.length;
    totalRemoved += report.removed.length;
    totalUnchanged += report.unchanged.length;
    console.log(
      `  Sync complete: +${report.added.length} added, -${report.removed.length} removed, =${report.unchanged.length} unchanged`,
    );
    if (report.added.length > 0) console.log(`  Added: ${report.added.join(", ")}`);
    if (report.removed.length > 0) console.log(`  Removed: ${report.removed.join(", ")}`);
  }

  console.log("\nDone.");
  trackMetric({ name: "model_scanner.scan_duration_ms", value: Date.now() - scanStart, properties: { service: "model-scanner-copilot", provider: PROVIDER } });
  trackMetric({ name: "model_scanner.models_found", value: scanResult.models.length, properties: { service: "model-scanner-copilot", provider: PROVIDER } });
  trackEvent({ name: "model_scanner.scan_completed", properties: { provider: PROVIDER, added: String(totalAdded), removed: String(totalRemoved), unchanged: String(totalUnchanged) } });
  await shutdownTelemetry();
}

main().catch((error) => {
  console.error("Model scanner failed:", error);
  process.exit(1);
});
