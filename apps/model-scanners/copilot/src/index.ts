// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import dotenv from "dotenv";
dotenv.config();

import { TokenManagerClient } from "@scope/secrets";
import {
  parseScannerArgs,
  waitForApi,
  reconcileModels,
  fetchAgentsByProvider,
} from "model-scanning";
import { scanCopilotModels } from "./scan.js";

const PROVIDER = "github-copilot";

async function main(): Promise<void> {
  const { dryRun, apiUrl } = parseScannerArgs();
  const tokenClient = new TokenManagerClient();

  console.log(`Model scanner: copilot (provider: ${PROVIDER})`);
  console.log(`Mode: ${dryRun ? "dry-run" : "live"}`);

  // Acquire token — must be an OAuth token, not a PAT (Copilot API rejects PATs)
  console.log("Acquiring token for copilot-models capability...");
  const token = await tokenClient.acquireToken("copilot-models");
  console.log("Token acquired.");

  // Scan models
  console.log("Scanning GitHub Copilot models...");
  const scanResult = await scanCopilotModels(token);
  console.log(`Found ${scanResult.models.length} models:`);
  for (const model of scanResult.models) {
    console.log(`  - ${model.id}`);
  }

  if (dryRun) {
    // Dry-run: output JSON and exit
    console.log("\n--- Dry-run output ---");
    console.log(JSON.stringify(scanResult, null, 2));
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
    process.exit(0);
  }

  console.log(`Found ${agents.length} agent(s): ${agents.map((a) => a._id).join(", ")}`);

  // Sync models for each agent
  for (const agent of agents) {
    console.log(`\nSyncing models for agent: ${agent._id}...`);
    const report = await reconcileModels(
      apiUrl,
      agent._id,
      PROVIDER,
      scanResult,
    );
    console.log(
      `  Sync complete: +${report.added.length} added, -${report.removed.length} removed, =${report.unchanged.length} unchanged`,
    );
    if (report.added.length > 0) console.log(`  Added: ${report.added.join(", ")}`);
    if (report.removed.length > 0) console.log(`  Removed: ${report.removed.join(", ")}`);
  }

  console.log("\nDone.");
}

main().catch((error) => {
  console.error("Model scanner failed:", error);
  process.exit(1);
});
