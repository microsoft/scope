#!/usr/bin/env npx tsx
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Test harness that runs inside the Docker container.
 *
 * Exercises runACPSession() with the real claude-agent-acp binary and outputs a
 * JSON result to stdout so the host-side vitest test can assert on it.
 *
 * Usage: npx tsx src/test-worker.ts
 *
 * Env vars (one credential required):
 *   ANTHROPIC_API_KEY      — Anthropic API key
 *   CLAUDE_CODE_OAUTH_TOKEN — Claude Code subscription OAuth token
 *   TEST_PROMPT            — First prompt to send (required)
 *   TEST_PROMPT_2          — Optional second prompt (tests session reuse)
 */
import { runACPSession } from "./acp-client.js";
import { createFreshWorkspace } from "@scope/core";
import { execSync } from "child_process";

interface PromptResult {
  success: boolean;
  response?: string;
  stopReason?: string;
  error?: string;
}

interface ToolCheck {
  tool: string;
  available: boolean;
  path?: string;
  version?: string;
}

interface TestResult {
  /** Results for each prompt (1 or 2 entries) */
  prompts: PromptResult[];
  /** CLI tool availability checks */
  toolChecks?: ToolCheck[];
  /** Which step the worker reached before it failed/completed */
  lastStep?: string;
  logs?: string[];
}

const collectedLogs: string[] = [];

function emit(msg: string): void {
  const ts = new Date().toISOString().substring(11, 23);
  const line = `[${ts}] ${msg}`;
  collectedLogs.push(line);
  process.stderr.write(line + "\n");
}

function checkTools(tools: string[]): ToolCheck[] {
  return tools.map((tool) => {
    try {
      const path = execSync(`which ${tool}`, { encoding: "utf-8" }).trim();
      let version: string | undefined;
      try {
        version = execSync(`${tool} --version`, { encoding: "utf-8" }).trim().split("\n")[0];
      } catch {}
      return { tool, available: true, path, version };
    } catch {
      return { tool, available: false };
    }
  });
}

async function main(): Promise<void> {
  emit("test-worker starting");

  // Check required CLI tools are available in PATH
  const toolChecks = checkTools(["pwsh", "python3", "git", "uv", "node", "go", "dotnet", "rustc", "cargo", "java", "mvn", "gradle"]);
  for (const tc of toolChecks) {
    emit(`tool ${tc.tool}: ${tc.available ? `found ${tc.path}` : "NOT FOUND"}${tc.version ? ` (${tc.version})` : ""}`);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const prompts = [process.env.TEST_PROMPT].filter(Boolean) as string[];
  if (process.env.TEST_PROMPT_2) prompts.push(process.env.TEST_PROMPT_2);

  const result: TestResult = { prompts: [], toolChecks };

  // If no credentials or prompts, report tool checks only
  if ((!apiKey && !oauthToken) || prompts.length === 0) {
    emit("No credentials or prompts — reporting tool checks only");
    result.logs = collectedLogs;
    console.log("TEST_RESULT:" + JSON.stringify(result));
    process.exit(toolChecks.every((t) => t.available) ? 0 : 1);
    return;
  }
  const workspacePath = createFreshWorkspace();
  emit(`Created workspace: ${workspacePath}`);

  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i];
    const label = i === 0 ? "first" : "second";
    emit(`${label} prompt: ${prompt}`);

    const promptResult: PromptResult = { success: false };
    try {
      emit(`calling runACPSession (${label})...`);
      const credentialEnv: Record<string, string> = oauthToken
        ? { CLAUDE_CODE_OAUTH_TOKEN: oauthToken }
        : { ANTHROPIC_API_KEY: apiKey! };

      const acpResult = await runACPSession(prompt, {
        command: "claude-agent-acp",
        args: [],
        env: {
          ...credentialEnv,
          HTTP_PROXY: "",
          HTTPS_PROXY: "",
          http_proxy: "",
          https_proxy: "",
          NODE_EXTRA_CA_CERTS: "",
        },
        cwd: workspacePath,
        onLog: (msg) => emit(`[acp] ${msg}`),
      });
      emit(`runACPSession (${label}) completed — stopReason=${acpResult.stopReason}`);
      promptResult.success = true;
      promptResult.response = acpResult.response;
      promptResult.stopReason = acpResult.stopReason;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      emit(`runACPSession (${label}) failed: ${msg}`);
      promptResult.error = msg;
      result.prompts.push(promptResult);
      break;
    }
    result.prompts.push(promptResult);
  }

  // Determine last step from logs
  const stepKeywords = [
    "Starting ACP agent",
    "Connected to agent",
    "Authenticated",
    "Created session",
    "Set session mode",
    "Sending prompt",
    "Agent completed",
  ];
  for (const kw of stepKeywords.reverse()) {
    if (collectedLogs.some((l) => l.includes(kw))) {
      result.lastStep = kw;
      break;
    }
  }

  result.logs = collectedLogs;

  const allSucceeded = result.prompts.every((p) => p.success);
  const allToolsOk = toolChecks.every((t) => t.available);
  emit(`last step reached: ${result.lastStep ?? "(none)"}`);
  emit(`prompts: ${result.prompts.length}, all succeeded: ${allSucceeded}, tools ok: ${allToolsOk}`);
  console.log("TEST_RESULT:" + JSON.stringify(result));

  process.exit(allSucceeded && allToolsOk ? 0 : 1);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  emit(`fatal error: ${msg}`);
  console.log(
    "TEST_RESULT:" +
      JSON.stringify({
        prompts: [{ success: false, error: msg }],
        logs: collectedLogs,
      }),
  );
  process.exit(1);
});
