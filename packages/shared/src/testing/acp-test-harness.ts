// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { execSync } from "child_process";
import { createFreshWorkspace } from "../utils/workspace.js";
import type { ACPIntegrationTestResult, PromptResult, ToolCheck } from "./docker-test-helpers.js";

export interface ACPTestSessionOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd: string;
  onLog: (message: string) => void;
  model?: string;
}

export interface ACPTestSessionResult {
  response?: string;
  stopReason?: string;
  confirmedModel?: string;
}

export interface ACPTestHarnessConfig {
  command: string;
  args?: string[];
  credentials: Record<string, string>;
  tools: string[];
  model?: string;
  runSession: (prompt: string, options: ACPTestSessionOptions) => Promise<ACPTestSessionResult>;
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

export async function runACPTestHarness(config: ACPTestHarnessConfig): Promise<never> {
  const collectedLogs: string[] = [];
  const emit = (msg: string): void => {
    const ts = new Date().toISOString().substring(11, 23);
    const line = `[${ts}] ${msg}`;
    collectedLogs.push(line);
    process.stderr.write(line + "\n");
  };

  const finish = (result: ACPIntegrationTestResult, exitCode: number): never => {
    result.logs = collectedLogs;
    console.log("TEST_RESULT:" + JSON.stringify(result));
    process.exit(exitCode);
  };

  emit("test-worker starting");
  const toolChecks = checkTools(config.tools);
  for (const tc of toolChecks) {
    emit(`tool ${tc.tool}: ${tc.available ? `found ${tc.path}` : "NOT FOUND"}${tc.version ? ` (${tc.version})` : ""}`);
  }

  const prompts = [process.env.TEST_PROMPT].filter(Boolean) as string[];
  if (process.env.TEST_PROMPT_2) prompts.push(process.env.TEST_PROMPT_2);
  const result: ACPIntegrationTestResult = { prompts: [], toolChecks };

  if (Object.keys(config.credentials).length === 0 || prompts.length === 0) {
    emit("No credentials or prompts — reporting tool checks only");
    return finish(result, toolChecks.every((tool) => tool.available) ? 0 : 1);
  }

  const workspacePath = createFreshWorkspace();
  emit(`Created workspace: ${workspacePath}`);

  for (let i = 0; i < prompts.length; i++) {
    const label = i === 0 ? "first" : "second";
    const prompt = prompts[i];
    emit(`${label} prompt: ${prompt}`);
    const promptResult: PromptResult = { success: false };
    try {
      emit(`calling runACPSession (${label})...`);
      const session = await config.runSession(prompt, {
        command: config.command,
        args: config.args ?? [],
        env: {
          ...config.credentials,
          HTTP_PROXY: "", HTTPS_PROXY: "", http_proxy: "", https_proxy: "", NODE_EXTRA_CA_CERTS: "",
        },
        cwd: workspacePath,
        onLog: (msg) => emit(`[acp] ${msg}`),
        model: config.model,
      });
      emit(`runACPSession (${label}) completed — stopReason=${session.stopReason}`);
      Object.assign(promptResult, {
        success: true,
        response: session.response,
        stopReason: session.stopReason,
        confirmedModel: session.confirmedModel,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit(`runACPSession (${label}) failed: ${message}`);
      promptResult.error = message;
      result.prompts.push(promptResult);
      break;
    }
    result.prompts.push(promptResult);
  }

  for (const keyword of ["Agent completed", "Sending prompt", "Set session mode", "Created session", "Authenticated", "Connected to agent", "Starting ACP agent"]) {
    if (collectedLogs.some((line) => line.includes(keyword))) {
      result.lastStep = keyword;
      break;
    }
  }

  const allSucceeded = result.prompts.every((prompt) => prompt.success);
  const allToolsOk = toolChecks.every((tool) => tool.available);
  emit(`last step reached: ${result.lastStep ?? "(none)"}`);
  emit(`prompts: ${result.prompts.length}, all succeeded: ${allSucceeded}, tools ok: ${allToolsOk}`);
  return finish(result, allSucceeded && allToolsOk ? 0 : 1);
}
