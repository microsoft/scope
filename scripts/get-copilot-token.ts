#!/usr/bin/env npx tsx
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Get a GitHub OAuth token for Copilot via device-code flow.
 *
 * Uses VS Code's OAuth app (client_id: 01ab8ac9400c4e429b23) with NO scopes.
 * The resulting scopeless token can be exchanged for a VSCODE_COPILOT_CHAT_TOKEN.
 *
 * Usage: npx tsx scripts/get-copilot-token.ts
 * Output: prints the token to stdout
 *
 * Example: export COPILOT_GITHUB_TOKEN=$(pnpm -s get-copilot-token)
 *
 * Based on: vscode-copilot-evaluation/src/proxy/ghOAuthTokenFetcher.ts
 */
import { execSync } from "child_process";

const CLIENT_ID = "01ab8ac9400c4e429b23";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

async function main() {
  // Step 1: Request device code
  const codeResponse = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });
  const codeData = await codeResponse.json();

  console.error("=".repeat(80));
  console.error("ATTENTION: To authenticate with GitHub for Copilot:");
  console.error();
  console.error(`  1. Copy this code: ${codeData.user_code}`);
  console.error(`  2. Open: ${codeData.verification_uri}`);
  console.error(`  3. Paste the code and approve access.`);
  console.error();

  // Try to open the browser
  try {
    const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    execSync(`${openCmd} ${codeData.verification_uri}`, { stdio: "ignore" });
    console.error("(Browser opened automatically)");
  } catch {
    console.error("(Could not open browser — please navigate manually)");
  }
  console.error();
  console.error(`Polling for approval (up to ${codeData.expires_in}s)...`);

  // Step 2: Poll for access token
  let expiresIn = codeData.expires_in;
  let accessToken;
  while (expiresIn > 0) {
    await new Promise((r) => setTimeout(r, codeData.interval * 1000));
    expiresIn -= codeData.interval;

    const tokenResponse = await fetch(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: codeData.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const tokenData = await tokenResponse.json();

    if (tokenData.access_token) {
      accessToken = tokenData.access_token;
      break;
    }
  }

  if (!accessToken) {
    console.error("❌ Failed to obtain access token within the time limit.");
    process.exit(1);
  }

  console.log(accessToken);
}

main().catch((err) => {
  console.error("❌", err.message);
  process.exit(1);
});
