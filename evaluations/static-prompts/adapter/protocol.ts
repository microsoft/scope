// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export const QUALITY_FAMILIES = [
  "criteria-authoring",
  "parent-dependency-suggestion",
  "child-dependency-suggestion",
  "task-prompt-generation",
  "task-prompt-variation",
  "prompt-feature-authoring",
  "prompt-feature-extraction",
  "judge-instructions",
  "developer-feedback",
  "run-report",
] as const;

export type QualityFamily = (typeof QUALITY_FAMILIES)[number];

export const RED_TEAM_SURFACES = [
  "task-scenario-prompt",
  "gate-prompt",
  "agents-md",
  "criterion-prompt",
  "prompt-feature-definition",
  "persona-instructions",
  "report-user-prompt",
  "report-system-prompt",
] as const;

export type RedTeamSurface = (typeof RED_TEAM_SURFACES)[number];

export interface PromptMessage {
  role: "system" | "developer" | "user" | "assistant";
  content: string;
}

export interface PromptToolDefinition {
  name: string;
  description?: string;
  parameters?: unknown;
}

export interface PromptFile {
  path: string;
  content: string;
  trust: "trusted" | "untrusted";
}

export interface ComposedPromptRequest {
  messages: PromptMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: PromptToolDefinition[];
  files?: PromptFile[];
  metadata: {
    adapterId: string;
    productionSources: string[];
    insertionPoint?: string;
    fidelity?: "exact" | "partial";
  };
}

export interface CompletionResult {
  content: string;
  metadata?: Record<string, unknown>;
}

export interface CompletionOptions {
  executeTool?: (name: string, arguments_: unknown) => Promise<unknown>;
  maxToolRounds?: number;
}

export interface AdapterContext {
  model: string;
  complete(
    request: ComposedPromptRequest,
    options?: CompletionOptions,
  ): Promise<CompletionResult>;
}

export interface AdapterExecution<Output = unknown> {
  request: ComposedPromptRequest;
  rawResponse: string;
  output: Output;
  invocationMetadata?: Record<string, unknown>;
}

export interface PromptTargetAdapter<Output = unknown> {
  readonly family: QualityFamily;
  readonly variants: readonly string[];
  run(
    input: unknown,
    variant: string,
    context: AdapterContext,
  ): Promise<AdapterExecution<Output>>;
}

export interface RedTeamComposition {
  surface: RedTeamSurface;
  request: ComposedPromptRequest;
  compositionFingerprint: string;
  sourceRevision: string;
}

export interface QualityCaseRow {
  id: string;
  family: QualityFamily;
  variant?: string;
  input: unknown;
  expected?: unknown;
}

export interface RedTeamCaseRow {
  id: string;
  surface: RedTeamSurface;
  attack: string;
  input?: unknown;
}

export type AdapterInputRow = QualityCaseRow | RedTeamCaseRow;

export interface AdapterSuccessRow {
  caseId: string;
  family?: QualityFamily;
  surface?: RedTeamSurface;
  variant?: string;
  sampleIndex: number;
  status: "ok";
  latencyMs: number;
  request: ComposedPromptRequest;
  rawResponse?: string;
  output?: unknown;
  compositionFingerprint?: string;
  sourceRevision?: string;
  invocationMetadata?: Record<string, unknown>;
}

export interface AdapterErrorRow {
  caseId: string;
  family?: QualityFamily;
  surface?: RedTeamSurface;
  variant?: string;
  sampleIndex: number;
  status: "error";
  latencyMs: number;
  error: {
    name: string;
    message: string;
    classification: "validation" | "transport" | "parse" | "adapter";
  };
}

export type AdapterOutputRow = AdapterSuccessRow | AdapterErrorRow;
