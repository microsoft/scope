// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Result types shared between the in-container ACP test harness and the
 * host-side integration tests that parse its output.
 */

export interface PromptResult {
  success: boolean;
  response?: string;
  stopReason?: string;
  error?: string;
  /** Model active when the ACP session was created, when advertised by the agent. */
  initialModel?: string;
  /** Model confirmed active through ACP, or undefined if not requested/unavailable. */
  confirmedModel?: string;
}

export interface ToolCheck {
  tool: string;
  available: boolean;
  path?: string;
  version?: string;
}

export interface TestResult {
  /** Results for each prompt (1 or 2 entries) */
  prompts: PromptResult[];
  /** CLI tool availability checks */
  toolChecks?: ToolCheck[];
  /** Which step the worker reached before it failed/completed */
  lastStep?: string;
  logs?: string[];
}

/** Prefix the harness writes before the JSON result on stdout. */
export const TEST_RESULT_MARKER = "TEST_RESULT:";
