// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Generic in-container test harness for ACP workers.
 *
 * Each worker's src/test-worker.ts is a thin wrapper that calls
 * runTestHarness() with its own ACP session function, command, and
 * credentials. The harness runs the prompts from TEST_PROMPT / TEST_PROMPT_2
 * and prints a TEST_RESULT JSON line for the host-side test to parse.
 *
 * Env vars:
 *   TEST_PROMPT   — First prompt to send (required to run prompts)
 *   TEST_PROMPT_2 — Optional second prompt (tests session reuse)
 *   TEST_MODEL    — Optional model to select via ACP set_model
 */
import { execSync } from "child_process";
import { createFreshWorkspace } from "shared";
import { TEST_RESULT_MARKER, type PromptResult, type TestResult, type ToolCheck } from "./types.js";

export interface HarnessSessionOptions {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  onLog: (message: string) => void;
  model?: string;
}

export interface HarnessSessionResult {
  response: string;
  stopReason: string;
  confirmedModel?: string;
}

export interface TestHarnessConfig {
  /** The worker's runACPSession implementation. */
  runSession: (prompt: string, options: HarnessSessionOptions) => Promise<HarnessSessionResult>;
  /** ACP agent command, e.g. "copilot" or "claude-agent-acp". */
  command: string;
  args: string[];
  /**
   * Credential env vars to pass to the agent, read from process.env.
   * Return undefined when no credentials are available; the harness then
   * reports tool checks only.
   */
  getCredentialEnv: () => Record<string, string> | undefined;
  /** CLI tools expected on PATH inside the image. */
  tools: string[];
}

// Log lines emitted by runACPSession, in the order they occur.
const STEP_KEYWORDS = [
  "Starting ACP agent",
  "Connected to agent",
  "Authenticated",
  "Created session",
  "Set session mode",
  "Sending prompt",
  "Agent completed",
];

/** Return the furthest ACP step reached, based on collected log lines. */
export function detectLastStep(logs: string[]): string | undefined {
  for (const kw of [...STEP_KEYWORDS].reverse()) {
    if (logs.some((l) => l.includes(kw))) return kw;
  }
  return undefined;
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

// Clear proxy settings so the agent talks to its API directly inside the test container.
const NO_PROXY_ENV: Record<string, string> = {
  HTTP_PROXY: "",
  HTTPS_PROXY: "",
  http_proxy: "",
  https_proxy: "",
  NODE_EXTRA_CA_CERTS: "",
};

export async function runTestHarness(config: TestHarnessConfig): Promise<never> {
  const collectedLogs: string[] = [];
  const emit = (msg: string): void => {
    const ts = new Date().toISOString().substring(11, 23);
    const line = `[${ts}] ${msg}`;
    collectedLogs.push(line);
    process.stderr.write(line + "\n");
  };
  const report = (result: TestResult, ok: boolean): never => {
    result.logs = collectedLogs;
    console.log(TEST_RESULT_MARKER + JSON.stringify(result));
    process.exit(ok ? 0 : 1);
  };

  try {
    emit("test-worker starting");

    const toolChecks = checkTools(config.tools);
    for (const tc of toolChecks) {
      emit(`tool ${tc.tool}: ${tc.available ? `found ${tc.path}` : "NOT FOUND"}${tc.version ? ` (${tc.version})` : ""}`);
    }
    const allToolsOk = toolChecks.every((t) => t.available);

    const credentialEnv = config.getCredentialEnv();
    const prompts = [process.env.TEST_PROMPT, process.env.TEST_PROMPT_2].filter(Boolean) as string[];
    const testModel = process.env.TEST_MODEL;

    const result: TestResult = { prompts: [], toolChecks };

    if (!credentialEnv || prompts.length === 0) {
      emit("No credentials or prompts — reporting tool checks only");
      return report(result, allToolsOk);
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
        const acpResult = await config.runSession(prompt, {
          command: config.command,
          args: config.args,
          env: { ...credentialEnv, ...NO_PROXY_ENV },
          cwd: workspacePath,
          onLog: (msg) => emit(`[acp] ${msg}`),
          ...(testModel && { model: testModel }),
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

    result.lastStep = detectLastStep(collectedLogs);
    const allSucceeded = result.prompts.every((p) => p.success);
    emit(`last step reached: ${result.lastStep ?? "(none)"}`);
    emit(`prompts: ${result.prompts.length}, all succeeded: ${allSucceeded}, tools ok: ${allToolsOk}`);
    return report(result, allSucceeded && allToolsOk);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit(`fatal error: ${msg}`);
    return report({ prompts: [{ success: false, error: msg }] }, false);
  }
}
