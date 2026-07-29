#!/usr/bin/env npx tsx
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Test harness that runs inside the Docker container.
 *
 * Exercises runACPSession() with the real copilot CLI binary and outputs a
 * JSON result to stdout so the host-side vitest test can assert on it.
 *
 * Usage: npx tsx src/test-worker.ts
 *
 * Env vars:
 *   GITHUB_TOKEN  — GitHub PAT for Copilot auth (required)
 *   TEST_PROMPT   — First prompt to send (required)
 *   TEST_PROMPT_2 — Optional second prompt (tests session reuse)
 *   TEST_MODEL    — Model to select via ACP set_model (e.g. "claude-opus-4.6")
 */
import { runACPSession } from "./acp-client.js";
import { createFreshWorkspace } from "@scope/core";
import { execSync } from "child_process";

interface PromptResult {
  success: boolean;
  response?: string;
  stopReason?: string;
  error?: string;
  /** Model confirmed active by ACP set_model, or undefined if not requested/unavailable. */
  confirmedModel?: string;
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

  const githubToken = process.env.GITHUB_TOKEN;
  const prompts = [process.env.TEST_PROMPT].filter(Boolean) as string[];
  if (process.env.TEST_PROMPT_2) prompts.push(process.env.TEST_PROMPT_2);

  const testModel = process.env.TEST_MODEL;

  const result: TestResult = { prompts: [], toolChecks };

  // If no credentials or prompts, report tool checks only
  if (!githubToken || prompts.length === 0) {
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
      const acpResult = await runACPSession(prompt, {
        command: "copilot",
        args: ["--acp", "--yolo"],
        env: {
          GITHUB_TOKEN: githubToken,
          HTTP_PROXY: "",
          HTTPS_PROXY: "",
          http_proxy: "",
          https_proxy: "",
          NODE_EXTRA_CA_CERTS: "",
        },
        cwd: workspacePath,
        onLog: (msg) => emit(`[acp] ${msg}`),
        model: testModel,
      });
      emit(`runACPSession (${label}) completed — stopReason=${acpResult.stopReason}`);
      promptResult.success = true;
      promptResult.response = acpResult.response;
      promptResult.stopReason = acpResult.stopReason;
      promptResult.confirmedModel = acpResult.confirmedModel;
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
