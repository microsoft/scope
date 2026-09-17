#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_BASE_URL = "https://msscope-int.azurewebsites.net";
export const DEFAULT_PROJECT_NAME = "Default Project";
export const DEFAULT_DATASET_VERSION = "v1";
export const DEFAULT_SEED = "scope-static-prompts-v1";

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
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface DatasetCase {
  schemaVersion: 1;
  id: string;
  family: QualityFamily;
  variant: string;
  input: Record<string, JsonValue>;
  expected: Record<string, JsonValue>;
  evaluators: string[];
  tags: string[];
  provenance: {
    kind: "integration" | "synthetic-reviewed";
    sourceEndpoints: string[];
    projectId: string;
    sourceEntityIds: string[];
    harvestedAt: string;
    selectionSeed: string;
    sourceHash: string;
    note?: string;
  };
  review: {
    status: "approved";
    method: string;
  };
}

export interface Project {
  id: string;
  name: string;
}

interface Criterion {
  id: string;
  prompt: string;
  dependsOn?: string[];
  gates?: string[];
  projectId: string;
}

interface PromptFeature {
  id: string;
  prompt: string;
  dependsOn?: string[];
  projectId: string;
}

interface PromptFeatureResult {
  featureId: string;
  detected: boolean;
  evaluated: boolean;
}

interface TaskPrompt {
  _id: string;
  keyId: string;
  type?: string;
  text?: string;
  contentBlobUrl?: string;
  features?: PromptFeatureResult[];
  projectId: string;
}

interface CriterionResult {
  criterionId: string;
  passed: boolean;
  feedback: string;
  evaluated: boolean;
}

interface ToolCall {
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  response?: string;
  timestamp?: string;
  iteration?: number;
}

interface ConversationTurn {
  iteration: number;
  gate?: string;
  codingAgentResponse?: string;
  judgeFeedback: string;
  passed: boolean;
  criteriaResults?: CriterionResult[];
  toolCalls?: ToolCall[];
  toolCallCount?: number;
  toolCallsUrl?: string;
}

interface RunState {
  _id: string;
  attemptNumber: number;
  status: string;
  outcome?: string;
  result?: string;
  turns?: ConversationTurn[];
}

interface RequestRecord {
  _id: string;
  scenario: { task: string; criteria: string[] };
  workerType: string;
  model?: string;
  maxIterations?: number;
  personaInstructions?: string;
  persona?: Record<string, unknown>;
  gateSummaries?: Array<{ gate: string; status: string; iterations: number }>;
  run?: RunState;
  projectId: string;
}

interface Report {
  _id: string;
  requestId: string;
  templateId?: string;
  content?: string;
  status: string;
  projectId: string;
}

interface ReportTemplate {
  _id: string;
  id: string;
  name: string;
  userPrompt: string;
  systemPrompt?: { mode: "append" | "override"; content: string };
  projectId: string;
}

export interface OpenApiDocument {
  paths?: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown> };
}

export interface HarvestOptions {
  baseUrl: string;
  projectId?: string;
  projectName?: string;
  tokenEnv?: string;
  datasetVersion: string;
  seed: string;
  outputDir: string;
  harvestedAt?: string;
}

interface SourceData {
  criteria: Criterion[];
  features: PromptFeature[];
  tasks: TaskPrompt[];
  requests: RequestRecord[];
  reports: Report[];
  templates: ReportTemplate[];
}

interface CurateOptions {
  projectId: string;
  harvestedAt: string;
  seed: string;
  toolCalls?: Map<string, ToolCall[]>;
}

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ENDPOINTS = {
  projects: "/api/v1/projects",
  criteria: "/api/v1/criteria",
  features: "/api/v1/prompt-features",
  tasks: "/api/v1/task-prompts",
  taskContent: "/api/v1/task-prompts/{id}/content",
  requests: "/api/v1/requests",
  toolCalls: "/api/v1/requests/{id}/runs/{runId}/tool-calls",
  reports: "/api/v1/reports",
  templates: "/api/v1/report-templates",
} as const;

const FAMILY_FILES: Record<QualityFamily, string> = {
  "criteria-authoring": "criteria-authoring.jsonl",
  "parent-dependency-suggestion": "dependency-suggestions.jsonl",
  "child-dependency-suggestion": "dependency-suggestions.jsonl",
  "task-prompt-generation": "task-prompts.jsonl",
  "task-prompt-variation": "task-prompts.jsonl",
  "prompt-feature-authoring": "prompt-features.jsonl",
  "prompt-feature-extraction": "prompt-features.jsonl",
  "judge-instructions": "judge.jsonl",
  "developer-feedback": "feedback.jsonl",
  "run-report": "reports.jsonl",
};

const LEGACY_CRITERIA_BEHAVIORS: Record<string, { behavior: string; evidenceSource: string }> = {
  rayfin_app_builds: {
    behavior: "The Rayfin application builds successfully without any TypeScript errors",
    evidenceSource: "tool-history",
  },
  rayfin_app_has_been_setup: {
    behavior:
      "The project is set up as a Rayfin app, with a rayfin/rayfin.yml config file and @microsoft/rayfin-* dependencies in package.json",
    evidenceSource: "codebase",
  },
  rayfin_bootstrap: {
    behavior: "The Rayfin app was bootstrapped using the @microsoft/create-rayfin package via npx",
    evidenceSource: "tool-history",
  },
  rayfin_data_models: {
    behavior:
      "The codebase defines Recipe and Favorite data models, both requiring authenticated access via the @authenticated('*') decorator",
    evidenceSource: "codebase",
  },
  rayfin_used_skill_and_mcp: {
    behavior: "The project loads and uses the Rayfin skill and the Rayfin MCP server after bootstrapping",
    evidenceSource: "tool-history",
  },
};

const EVALUATORS: Record<QualityFamily, string[]> = {
  "criteria-authoring": ["generation_success", "output_schema", "non_empty_prompt", "valid_identifier", "candidate_references", "criteria_evidence_source", "criteria_quality", "relevance", "coherence"],
  "parent-dependency-suggestion": ["generation_success", "output_schema", "candidate_references", "dependency_direction", "relevance"],
  "child-dependency-suggestion": ["generation_success", "output_schema", "candidate_references", "dependency_direction", "relevance"],
  "task-prompt-generation": ["generation_success", "output_schema", "non_empty_prompt", "no_existing_duplicate", "sample_diversity", "task_prompt_quality", "relevance", "coherence", "fluency", "intent_resolution"],
  "task-prompt-variation": ["generation_success", "output_schema", "non_empty_prompt", "no_existing_duplicate", "sample_diversity", "variation_quality", "relevance", "coherence", "fluency", "intent_resolution"],
  "prompt-feature-authoring": ["generation_success", "output_schema", "non_empty_definition", "valid_identifier", "candidate_references", "feature_definition_quality", "relevance", "coherence"],
  "prompt-feature-extraction": ["generation_success", "output_schema", "feature_result_coverage", "candidate_references", "label_metrics", "suggested_feature_novelty"],
  "judge-instructions": ["generation_success", "output_schema", "criterion_coverage", "judge_verdict", "groundedness", "task_adherence", "tool_call_accuracy"],
  "developer-feedback": ["generation_success", "output_schema", "non_empty_feedback", "forbidden_language", "no_questions", "descendant_leakage_check", "feedback_quality", "descendant_leakage", "relevance", "coherence", "groundedness", "task_adherence", "fluency", "intent_resolution"],
  "run-report": ["generation_success", "output_schema", "non_empty_report", "valid_markdown", "no_fabricated_references", "report_quality", "report_simulation_interpretation", "relevance", "coherence", "fluency", "groundedness", "task_adherence", "tool_call_accuracy"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function deterministicScore(seed: string, value: string): string {
  return sha256(`${seed}\0${value}`);
}

export function deterministicSample<T>(
  values: readonly T[],
  count: number,
  seed: string,
  identity: (value: T) => string,
): T[] {
  return [...values]
    .sort((a, b) => {
      const score = deterministicScore(seed, identity(a)).localeCompare(
        deterministicScore(seed, identity(b)),
      );
      return score || identity(a).localeCompare(identity(b));
    })
    .slice(0, count);
}

export function stratifiedSample<T>(
  values: readonly T[],
  count: number,
  seed: string,
  identity: (value: T) => string,
  stratum: (value: T) => string,
): T[] {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = stratum(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  const queues = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, group]) => deterministicSample(group, group.length, `${seed}:${key}`, identity));
  const selected: T[] = [];
  while (selected.length < count && queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) {
      const value = queue.shift();
      if (value !== undefined) selected.push(value);
      if (selected.length === count) break;
    }
  }
  return selected;
}

function truncate(text: string, maximum = 2_000): string {
  return text.length <= maximum ? text : `${text.slice(0, maximum)}\n[TRUNCATED]`;
}

function redactReportContent(input: string): string {
  return input.replace(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
    "[REDACTED_ID]",
  );
}

export function redactText(input: string): string {
  return input
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED_SECRET]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED_SECRET]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_SECRET]")
    .replace(
      /\b(api[-_ ]?key|access[-_ ]?token|client[-_ ]?secret|password)\b(\s*[:=]\s*)(["']?)[^\s"',;]+/gi,
      "$1$2$3[REDACTED_SECRET]",
    )
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
    .replace(/\/Users\/[^/\s]+/g, "/Users/[REDACTED_USER]")
    .replace(/C:\\Users\\[^\\\s]+/gi, "C:\\Users\\[REDACTED_USER]")
    .replace(
      /https?:\/\/[^\s)"'>]+/gi,
      (url) => {
        const stripped = url.replace(/[.,;:]$/, "");
        const suffix = url.slice(stripped.length);
        try {
          const parsed = new URL(stripped);
          if (
            /(?:^|\.)blob\.core\.windows\.net$/i.test(parsed.hostname) ||
            /(?:^|\.)file\.core\.windows\.net$/i.test(parsed.hostname) ||
            [...parsed.searchParams.keys()].some((key) =>
              /^(?:sig|se|sp|sv|spr|srt|ss|token|key|code)$/i.test(key),
            )
          ) {
            return `[REDACTED_STORAGE_URL]${suffix}`;
          }
          if (parsed.username || parsed.password) return `[REDACTED_URL]${suffix}`;
          if (parsed.search) return `${parsed.origin}${parsed.pathname}?[REDACTED_QUERY]${suffix}`;
          return `${stripped}${suffix}`;
        } catch {
          return `[REDACTED_URL]${suffix}`;
        }
      },
    );
}

export function redactValue(value: unknown): JsonValue {
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.map(redactValue);
  if (!isRecord(value)) return String(value);
  const result: Record<string, JsonValue> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (/^(?:harUrl|snapshotUrl|logsUrl|rawChatUrl|chatResultUrl|videoUrls|setupVideoUrls|contentBlobUrl)$/i.test(key)) {
      continue;
    }
    if (/^(?:authorization|cookie|set-cookie|token|apiKey|clientSecret|password)$/i.test(key)) {
      result[key] = "[REDACTED_SECRET]";
      continue;
    }
    result[key] = redactValue(nested);
  }
  return result;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function retryDelay(response: Response | undefined, attempt: number): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1_000, 30_000);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), 30_000);
  }
  return Math.min(500 * 2 ** attempt, 8_000);
}

export class ScopeApiClient {
  private openApi?: OpenApiDocument;

  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private headers(): HeadersInit {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  private async request(path: string): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let response: Response | undefined;
      try {
        response = await this.fetchFn(new URL(path, `${this.baseUrl}/`), {
          headers: this.headers(),
        });
        if (response.ok) return response;
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable) {
          throw new Error(`GET ${path} failed with HTTP ${response.status}: ${truncate(await response.text(), 500)}`);
        }
        lastError = new Error(`GET ${path} failed with transient HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
        if (error instanceof Error && /HTTP 4\d\d/.test(error.message) && !/HTTP 429/.test(error.message)) {
          throw error;
        }
      }
      if (attempt < 4) await delay(retryDelay(response, attempt));
    }
    throw lastError instanceof Error ? lastError : new Error(`GET ${path} failed`);
  }

  private async json(path: string): Promise<unknown> {
    const response = await this.request(path);
    return (await response.json()) as unknown;
  }

  async initialize(): Promise<OpenApiDocument> {
    const spec = requireRecord(await this.json("/openapi.json"), "OpenAPI document") as OpenApiDocument;
    validateOpenApi(spec);
    this.openApi = spec;
    return spec;
  }

  private ensureInitialized(): void {
    if (!this.openApi) throw new Error("OpenAPI must be fetched and validated before data endpoints");
  }

  async projects(): Promise<Project[]> {
    this.ensureInitialized();
    return requireArray(await this.json(ENDPOINTS.projects), "projects").map((value, index) => {
      const row = requireRecord(value, `projects[${index}]`);
      return { id: requireString(row.id, "project.id"), name: requireString(row.name, "project.name") };
    });
  }

  async arrayEndpoint<T>(path: string, projectId: string): Promise<T[]> {
    this.ensureInitialized();
    const url = `${path}?projectId=${encodeURIComponent(projectId)}`;
    return requireArray(await this.json(url), path) as T[];
  }

  async taskPrompts(projectId: string, pageSize = 100): Promise<TaskPrompt[]> {
    this.ensureInitialized();
    const all: TaskPrompt[] = [];
    let offset = 0;
    let total = Number.POSITIVE_INFINITY;
    while (offset < total) {
      const path = `${ENDPOINTS.tasks}?projectId=${encodeURIComponent(projectId)}&limit=${pageSize}&offset=${offset}`;
      const page = requireRecord(await this.json(path), "task prompt page");
      const items = requireArray(page.items, "task prompt page.items") as TaskPrompt[];
      if (
        typeof page.total !== "number" ||
        typeof page.limit !== "number" ||
        typeof page.offset !== "number"
      ) {
        throw new Error("task prompt page has an invalid pagination shape");
      }
      if (page.offset !== offset) throw new Error(`task prompt page returned offset ${page.offset}, expected ${offset}`);
      total = page.total;
      all.push(...items);
      if (items.length === 0) break;
      offset += items.length;
    }
    for (const task of all) {
      if (!task.text) {
        const path = ENDPOINTS.taskContent.replace("{id}", encodeURIComponent(task._id));
        const body = requireRecord(await this.json(path), "task prompt content");
        task.text = requireString(body.text, "task prompt content.text");
      }
    }
    return all;
  }

  async requests(projectId: string, pageSize = 100): Promise<RequestRecord[]> {
    this.ensureInitialized();
    const all: RequestRecord[] = [];
    let after: string | null = null;
    const seenCursors = new Set<string>();
    do {
      const query = new URLSearchParams({
        projectId,
        limit: String(pageSize),
        sortBy: "id",
        sortDir: "asc",
      });
      if (after) query.set("after", after);
      const page = requireRecord(await this.json(`${ENDPOINTS.requests}?${query}`), "request page");
      const data = requireArray(page.data, "request page.data") as RequestRecord[];
      const cursors = requireRecord(page.cursors, "request page.cursors");
      const next = cursors.next;
      if (next !== null && typeof next !== "string") {
        throw new Error("request page cursors.next must be a string or null");
      }
      all.push(...data);
      if (next === null || data.length === 0) break;
      if (seenCursors.has(next)) throw new Error(`request pagination repeated cursor ${next}`);
      seenCursors.add(next);
      after = next;
    } while (after);
    return all;
  }

  async toolCalls(requestId: string, runId: string, iteration: number): Promise<ToolCall[]> {
    this.ensureInitialized();
    const path = ENDPOINTS.toolCalls
      .replace("{id}", encodeURIComponent(requestId))
      .replace("{runId}", encodeURIComponent(runId));
    const response = await this.request(`${path}?iteration=${iteration}`);
    const body = await response.text();
    if (!body.trim()) return [];
    return body
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line, index) => requireRecord(JSON.parse(line) as unknown, `tool call line ${index + 1}`) as ToolCall);
  }
}

function resolveSchema(spec: OpenApiDocument, schema: unknown): Record<string, unknown> {
  const candidate = requireRecord(schema, "OpenAPI schema");
  if (typeof candidate.$ref !== "string") return candidate;
  const prefix = "#/components/schemas/";
  if (!candidate.$ref.startsWith(prefix)) throw new Error(`Unsupported OpenAPI reference ${candidate.$ref}`);
  const name = candidate.$ref.slice(prefix.length);
  return requireRecord(spec.components?.schemas?.[name], `OpenAPI schema ${name}`);
}

function responseSchema(spec: OpenApiDocument, path: string): Record<string, unknown> {
  const operation = requireRecord(spec.paths?.[path]?.get, `OpenAPI GET ${path}`);
  const responses = requireRecord(operation.responses, `OpenAPI responses for ${path}`);
  const ok = requireRecord(responses["200"], `OpenAPI 200 response for ${path}`);
  const content = requireRecord(ok.content, `OpenAPI content for ${path}`);
  const json = requireRecord(content["application/json"], `OpenAPI JSON response for ${path}`);
  return resolveSchema(spec, json.schema);
}

function hasRequiredProperties(schema: Record<string, unknown>, properties: string[]): boolean {
  const required = Array.isArray(schema.required) ? schema.required : [];
  return properties.every((property) => required.includes(property));
}

export function validateOpenApi(spec: OpenApiDocument): void {
  if (!isRecord(spec.paths)) throw new Error("OpenAPI document has no paths");
  for (const path of Object.values(ENDPOINTS)) {
    const operation = spec.paths[path]?.get;
    if (!isRecord(operation)) throw new Error(`OpenAPI does not define GET ${path}`);
  }

  for (const path of [ENDPOINTS.criteria, ENDPOINTS.features, ENDPOINTS.tasks, ENDPOINTS.requests, ENDPOINTS.reports, ENDPOINTS.templates]) {
    const operation = requireRecord(spec.paths[path]?.get, `OpenAPI GET ${path}`);
    const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
    const project = parameters.find((parameter) => isRecord(parameter) && parameter.name === "projectId");
    if (!isRecord(project) || project.in !== "query") {
      throw new Error(`OpenAPI GET ${path} must accept projectId as a query parameter`);
    }
  }

  const projects = responseSchema(spec, ENDPOINTS.projects);
  const criteria = responseSchema(spec, ENDPOINTS.criteria);
  const features = responseSchema(spec, ENDPOINTS.features);
  const tasks = responseSchema(spec, ENDPOINTS.tasks);
  const reports = responseSchema(spec, ENDPOINTS.reports);
  const templates = responseSchema(spec, ENDPOINTS.templates);
  if (projects.type !== "array" || criteria.type !== "array" || features.type !== "array" || reports.type !== "array" || templates.type !== "array") {
    throw new Error("OpenAPI collection response shape changed");
  }
  if (tasks.type !== "object" || !hasRequiredProperties(tasks, ["items", "total", "limit", "offset"])) {
    throw new Error("OpenAPI task prompt pagination shape changed");
  }

  const requests = responseSchema(spec, ENDPOINTS.requests);
  const alternatives = Array.isArray(requests.anyOf) ? requests.anyOf : [requests];
  const paginatedRuns = alternatives
    .map((schema) => resolveSchema(spec, schema))
    .find((schema) => hasRequiredProperties(schema, ["data", "limit", "estimatedTotal", "cursors"]));
  if (!paginatedRuns) throw new Error("OpenAPI request cursor pagination shape changed");
}

function normalizeForDedup(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function deduplicateByText<T>(values: readonly T[], text: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = normalizeForDedup(text(value));
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function deduplicateByKey<T>(values: readonly T[], keyFor: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = keyFor(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function gateKey(criterion: Criterion): string {
  return [...(criterion.gates ?? ["none"])].sort().join("+");
}

function criterionDepth(id: string, byId: Map<string, Criterion>, visiting = new Set<string>()): number {
  if (visiting.has(id)) return 0;
  visiting.add(id);
  const criterion = byId.get(id);
  const parents = criterion?.dependsOn ?? [];
  const depth = parents.length === 0
    ? 0
    : 1 + Math.max(...parents.map((parent) => criterionDepth(parent, byId, new Set(visiting))));
  return depth;
}

function promptComplexity(text: string): string {
  if (text.length < 160) return "short";
  if (text.length < 360) return "medium";
  return "long";
}

function describeIdentifier(id: string): string {
  const words = id.replace(/^(?:asks_for|requires|uses)_/, "").replace(/_/g, " ");
  return `Detect whether the task ${words}.`;
}

function describeCriterion(criterion: Criterion): string {
  return LEGACY_CRITERIA_BEHAVIORS[criterion.id]?.behavior
    ?? `The completed work satisfies ${criterion.id.replace(/_/g, " ")}.`;
}

function describeTask(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const sentence = clean.match(/^.{20,240}?(?:[.!?](?:\s|$)|$)/)?.[0]?.trim();
  return sentence && sentence.length >= 20 ? sentence : truncate(clean, 240);
}

function sourceHash(source: unknown): string {
  return sha256(canonicalize(redactValue(source)));
}

function caseId(family: QualityFamily, variant: string, sourceIds: string[]): string {
  return `${family}-${sha256(`${family}\0${variant}\0${sourceIds.join("\0")}`).slice(0, 16)}`;
}

function makeCase(
  family: QualityFamily,
  variant: string,
  input: Record<string, unknown>,
  expected: Record<string, unknown>,
  tags: string[],
  source: unknown,
  sourceEntityIds: string[],
  sourceEndpoints: string[],
  options: CurateOptions,
  provenance?: { kind?: "integration" | "synthetic-reviewed"; note?: string },
): DatasetCase {
  const redactedInput = redactValue(input);
  const redactedExpected = redactValue(expected);
  if (!isRecord(redactedInput) || !isRecord(redactedExpected)) {
    throw new Error(`Case ${family} input and expected values must be objects`);
  }
  return {
    schemaVersion: 1,
    id: caseId(family, variant, sourceEntityIds),
    family,
    variant,
    input: redactedInput as Record<string, JsonValue>,
    expected: redactedExpected as Record<string, JsonValue>,
    evaluators: EVALUATORS[family],
    tags: [...new Set(tags)].sort(),
    provenance: {
      kind: provenance?.kind ?? "integration",
      sourceEndpoints,
      projectId: options.projectId,
      sourceEntityIds,
      harvestedAt: options.harvestedAt,
      selectionSeed: options.seed,
      sourceHash: sourceHash(source),
      ...(provenance?.note ? { note: provenance.note } : {}),
    },
    review: {
      status: "approved",
      method: "deterministic-curation-v1",
    },
  };
}

function candidateCriteria(criteria: Criterion[], excludeId: string, seed: string, requiredIds: string[] = []): Criterion[] {
  const required = requiredIds
    .map((id) => criteria.find((criterion) => criterion.id === id))
    .filter((criterion): criterion is Criterion => Boolean(criterion));
  const rest = deterministicSample(
    criteria.filter((criterion) => criterion.id !== excludeId && !requiredIds.includes(criterion.id)),
    Math.max(0, 20 - required.length),
    seed,
    (criterion) => criterion.id,
  );
  return [...required, ...rest].map(({ id, prompt, dependsOn, gates }) => ({ id, prompt, dependsOn, gates, projectId: "" }));
}

function taskCategory(task: TaskPrompt): string {
  const text = task.text ?? "";
  const technology = [
    "typescript", "javascript", "python", "rust", "go", "react", "azure", "api", "cli",
  ].find((word) => text.toLowerCase().includes(word)) ?? "other";
  return `${task.type ?? "select"}:${technology}:${promptComplexity(text)}`;
}

function requestOutcome(request: RequestRecord): string {
  return request.run?.outcome ?? request.run?.status ?? "unknown";
}

function childIds(criterionId: string, criteria: Criterion[]): string[] {
  return criteria
    .filter((candidate) => candidate.dependsOn?.includes(criterionId))
    .map((candidate) => candidate.id)
    .sort();
}

function descendantIds(criterionId: string, criteria: Criterion[]): string[] {
  const descendants = new Set<string>();
  const visit = (parentId: string): void => {
    for (const child of childIds(parentId, criteria)) {
      if (descendants.has(child)) continue;
      descendants.add(child);
      visit(child);
    }
  };
  visit(criterionId);
  return [...descendants].sort();
}

function rootFailedIds(results: CriterionResult[], criteriaById: Map<string, Criterion>): string[] {
  const failed = new Set(
    results.filter((result) => result.evaluated && !result.passed).map((result) => result.criterionId),
  );
  const hasFailedAncestor = (id: string, seen = new Set<string>()): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    for (const parent of criteriaById.get(id)?.dependsOn ?? []) {
      if (failed.has(parent) || hasFailedAncestor(parent, seen)) return true;
    }
    return false;
  };
  return results
    .filter((result) => failed.has(result.criterionId) && !hasFailedAncestor(result.criterionId))
    .map((result) => result.criterionId);
}

function criteriaCases(criteria: Criterion[], options: CurateOptions): DatasetCase[] {
  const byId = new Map(criteria.map((criterion) => [criterion.id, criterion]));
  const deduped = deduplicateByText(criteria, (criterion) => criterion.prompt);
  const legacy = Object.keys(LEGACY_CRITERIA_BEHAVIORS)
    .map((id) => byId.get(id))
    .filter((criterion): criterion is Criterion => Boolean(criterion));
  const selected = [
    ...legacy,
    ...stratifiedSample(
      deduped.filter((criterion) => !LEGACY_CRITERIA_BEHAVIORS[criterion.id]),
      Math.max(0, 20 - legacy.length),
      `${options.seed}:criteria`,
      (criterion) => criterion.id,
      (criterion) => `${gateKey(criterion)}:depth-${Math.min(criterionDepth(criterion.id, byId), 2)}:${promptComplexity(criterion.prompt)}`,
    ),
  ];

  const authoring = selected.map((criterion) => {
    const evidenceSource = LEGACY_CRITERIA_BEHAVIORS[criterion.id]?.evidenceSource ?? "unclear";
    return makeCase(
      "criteria-authoring",
      "default",
      {
        behavior: describeCriterion(criterion),
        gates: criterion.gates ?? [],
        existingCriteria: candidateCriteria(criteria, criterion.id, `${options.seed}:author:${criterion.id}`, criterion.dependsOn),
      },
      {
        referenceId: criterion.id,
        referencePrompt: criterion.prompt,
        criteria_evidence_source: evidenceSource.replace("-", "_"),
        evidenceSource,
      },
      [gateKey(criterion), `depth-${criterionDepth(criterion.id, byId)}`, promptComplexity(criterion.prompt), evidenceSource],
      criterion,
      [criterion.id],
      [ENDPOINTS.criteria],
      options,
    );
  });

  const parentPool = [...criteria].sort((a, b) => {
    const dependencyDelta = (b.dependsOn?.length ?? 0) - (a.dependsOn?.length ?? 0);
    return dependencyDelta || a.id.localeCompare(b.id);
  });
  const parentSelected = stratifiedSample(
    parentPool,
    15,
    `${options.seed}:parent`,
    (criterion) => criterion.id,
    (criterion) => `${gateKey(criterion)}:${(criterion.dependsOn?.length ?? 0) > 0 ? "positive" : "negative"}`,
  );
  const parents = parentSelected.map((criterion) =>
    makeCase(
      "parent-dependency-suggestion",
      "default",
      {
        behavior: describeCriterion(criterion),
        gates: criterion.gates ?? [],
        existingCriteria: candidateCriteria(criteria, criterion.id, `${options.seed}:parent-candidates:${criterion.id}`, criterion.dependsOn),
        candidates: candidateCriteria(criteria, criterion.id, `${options.seed}:parent-candidates:${criterion.id}`, criterion.dependsOn),
      },
      { suggestions: criterion.dependsOn ?? [] },
      [gateKey(criterion), (criterion.dependsOn?.length ?? 0) > 0 ? "positive" : "negative"],
      criterion,
      [criterion.id, ...(criterion.dependsOn ?? [])],
      [ENDPOINTS.criteria],
      options,
    ));

  const childSelected = stratifiedSample(
    criteria,
    15,
    `${options.seed}:child`,
    (criterion) => criterion.id,
    (criterion) => `${gateKey(criterion)}:${childIds(criterion.id, criteria).length > 0 ? "positive" : "negative"}`,
  );
  const children = childSelected.map((criterion) => {
    const expectedChildren = childIds(criterion.id, criteria);
    return makeCase(
      "child-dependency-suggestion",
      "default",
      {
        behavior: describeCriterion(criterion),
        gates: criterion.gates ?? [],
        existingCriteria: candidateCriteria(criteria, criterion.id, `${options.seed}:child-candidates:${criterion.id}`, expectedChildren),
        candidates: candidateCriteria(criteria, criterion.id, `${options.seed}:child-candidates:${criterion.id}`, expectedChildren),
      },
      { suggestions: expectedChildren },
      [gateKey(criterion), expectedChildren.length > 0 ? "positive" : "negative"],
      criterion,
      [criterion.id, ...expectedChildren],
      [ENDPOINTS.criteria],
      options,
    );
  });
  return [...authoring, ...parents, ...children];
}

function taskCases(tasks: TaskPrompt[], options: CurateOptions): DatasetCase[] {
  const usable = deduplicateByText(
    tasks.filter((task) => typeof task.text === "string" && task.text.trim().length > 0),
    (task) => task.text ?? "",
  );
  const selected = stratifiedSample(usable, 20, `${options.seed}:tasks`, (task) => task._id, taskCategory);
  const promptPool = deterministicSample(usable, 30, `${options.seed}:existing-prompts`, (task) => task._id);
  const generation = selected.map((task) =>
    makeCase(
      "task-prompt-generation",
      "default",
      {
        description: describeTask(task.text ?? ""),
        existingPrompts: promptPool.filter((candidate) => candidate._id !== task._id).slice(0, 12).map((candidate) => candidate.text ?? ""),
      },
      { referenceTaskPrompt: task.text ?? "" },
      [task.type ?? "select", promptComplexity(task.text ?? ""), taskCategory(task)],
      task,
      [task._id],
      [ENDPOINTS.tasks, ...(task.contentBlobUrl ? [ENDPOINTS.taskContent] : [])],
      options,
    ));

  const variation = selected.map((task, index) => {
    const neighbor = selected[(index + 1) % selected.length];
    return makeCase(
      "task-prompt-variation",
      "default",
      {
        existingPrompt: task.text ?? "",
        description: "Preserve the core intent and complexity while changing the technology or domain details.",
        existingPrompts: promptPool.filter((candidate) => candidate._id !== task._id).slice(0, 12).map((candidate) => candidate.text ?? ""),
      },
      { referenceTaskPrompt: neighbor.text ?? "" },
      [task.type ?? "select", promptComplexity(task.text ?? ""), "semantic-neighborhood"],
      [task, neighbor],
      [task._id, neighbor._id],
      [ENDPOINTS.tasks],
      options,
    );
  });
  return [...generation, ...variation];
}

function featureCases(features: PromptFeature[], tasks: TaskPrompt[], options: CurateOptions): DatasetCase[] {
  const allFeatures = [...features]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(({ id, prompt, dependsOn }) => ({ id, prompt, dependsOn }));
  const authoring = deterministicSample(features, Math.min(20, features.length), `${options.seed}:feature-author`, (feature) => feature.id)
    .map((feature) =>
      makeCase(
        "prompt-feature-authoring",
        "default",
        {
          behavior: describeIdentifier(feature.id),
          existingFeatures: allFeatures.filter((candidate) => candidate.id !== feature.id),
        },
        {
          referenceId: feature.id,
          referencePrompt: feature.prompt,
          suggestedParents: feature.dependsOn ?? [],
          suggestedChildren: features.filter((candidate) => candidate.dependsOn?.includes(feature.id)).map((candidate) => candidate.id),
        },
        [(feature.dependsOn?.length ?? 0) > 0 ? "has-parent" : "root"],
        feature,
        [feature.id],
        [ENDPOINTS.features],
        options,
      ));

  const labeled = tasks.filter((task) => task.text && task.features?.some((result) => result.evaluated));
  const selected = stratifiedSample(
    labeled,
    Math.min(30, labeled.length),
    `${options.seed}:feature-extract`,
    (task) => task._id,
    (task) => {
      const positives = task.features?.filter((result) => result.evaluated && result.detected).length ?? 0;
      return positives === 0 ? "negative" : positives >= 4 ? "many-positive" : "positive";
    },
  );
  const extraction = selected.map((task, index) => {
    const noExistingFeatures = index < 2;
    return makeCase(
      "prompt-feature-extraction",
      "default",
      {
        taskText: task.text ?? "",
        features: noExistingFeatures ? [] : allFeatures,
      },
      {
        results: noExistingFeatures
          ? []
          : (task.features ?? []).map(({ featureId, detected, evaluated }) => ({ featureId, detected, evaluated })),
        suggestedFeatures: [],
      },
      [
        noExistingFeatures ? "no-existing-features" : "existing-features",
        (task.features?.some((result) => result.detected) ?? false) ? "positive" : "negative",
      ],
      task,
      [task._id],
      [ENDPOINTS.tasks, ENDPOINTS.features],
      options,
    );
  });
  return [...authoring, ...extraction];
}

interface TurnCandidate {
  request: RequestRecord;
  turn: ConversationTurn;
}

function turnCandidates(requests: RequestRecord[]): TurnCandidate[] {
  return requests.flatMap((request) =>
    (request.run?.turns ?? [])
      .filter((turn) => (turn.criteriaResults?.length ?? 0) > 0)
      .map((turn) => ({ request, turn })));
}

function minimalCriteria(ids: string[], criteriaById: Map<string, Criterion>): Array<Record<string, JsonValue>> {
  const expanded = new Set<string>();
  const addWithAncestors = (id: string): void => {
    if (expanded.has(id)) return;
    const criterion = criteriaById.get(id);
    if (!criterion) return;
    for (const parent of criterion.dependsOn ?? []) addWithAncestors(parent);
    expanded.add(id);
  };
  for (const id of ids) addWithAncestors(id);
  return [...expanded]
    .map((id) => criteriaById.get(id))
    .filter((criterion): criterion is Criterion => Boolean(criterion))
    .map(({ id, prompt, dependsOn, gates }) => ({
      id,
      prompt: redactText(prompt),
      dependsOn: (dependsOn ?? []).filter((parent) => expanded.has(parent)),
      gates: gates ?? [],
    }));
}

function sanitizeToolCall(call: ToolCall): Record<string, JsonValue> {
  return {
    name: redactText(call.name ?? "unknown"),
    arguments: redactValue(call.arguments ?? {}),
    ...(call.response ? { response: truncate(redactText(call.response), 800) } : {}),
  };
}

function judgeCases(criteria: Criterion[], requests: RequestRecord[], options: CurateOptions): DatasetCase[] {
  const criteriaById = new Map(criteria.map((criterion) => [criterion.id, criterion]));
  const candidates = turnCandidates(requests);
  const selected = stratifiedSample(
    candidates,
    24,
    `${options.seed}:judge`,
    ({ request, turn }) => `${request._id}:${request.run?._id}:${turn.iteration}`,
    ({ turn }) => `${turn.gate ?? "select"}:${turn.passed ? "passed" : "failed"}:${(turn.toolCallCount ?? 0) > 0 ? "tools" : "no-tools"}`,
  );
  const direct = selected.flatMap(({ request, turn }) => {
    const run = request.run;
    if (!run) return [];
    const sourceIds = [request._id, run._id, String(turn.iteration)];
    const allToolCalls = options.toolCalls?.get(`${request._id}:${run._id}:${turn.iteration}`) ?? turn.toolCalls ?? [];
    const relevantToolCalls = allToolCalls.filter((call) => call.iteration === undefined || call.iteration === turn.iteration);
    const criteriaIds = (turn.criteriaResults ?? []).map(
      (result) => result.criterionId,
    );
    const conversationHistory = (run.turns ?? [])
      .filter((candidate) => candidate.iteration < turn.iteration)
      .map((candidate) => ({
        iteration: candidate.iteration,
        judgeFeedback: candidate.judgeFeedback,
        snapshotUrl: "",
        passed: candidate.passed,
        timestamp: new Date(0).toISOString(),
        codingAgentResponse: truncate(candidate.codingAgentResponse ?? "", 1_000),
        criteriaResults: candidate.criteriaResults ?? [],
      }));
    return [
      makeCase(
        "judge-instructions",
        turn.iteration % 2 === 0 ? "bundled" : "independent",
        {
          criteria: minimalCriteria(criteriaIds, criteriaById),
          conversationHistory,
          iterationToolCalls: [{
            iteration: turn.iteration,
            toolCalls: relevantToolCalls.slice(0, 12).map(sanitizeToolCall),
          }],
          currentAgentResponse: truncate(turn.codingAgentResponse ?? "", 2_000),
          workspaceFiles: {},
        },
        {
          results: turn.criteriaResults ?? [],
          turnPassed: turn.passed,
          referenceFeedback: turn.judgeFeedback,
        },
        [
          turn.gate ?? "select",
          turn.passed ? "passed" : "failed",
          relevantToolCalls.length > 0 || (turn.toolCallCount ?? 0) > 0 ? "tool-evidence" : "agent-response-evidence",
        ],
        { request, turn, toolCalls: relevantToolCalls },
        sourceIds,
        [ENDPOINTS.requests, ...(relevantToolCalls.length > 0 ? [ENDPOINTS.toolCalls] : [])],
        options,
      ),
    ];
  });

  const syntheticFixtures: Array<{
    id: string;
    variant: "bundled" | "independent";
    input: Record<string, unknown>;
    expected: Record<string, unknown>;
    tags: string[];
  }> = [
    {
      id: "filesystem-pass",
      variant: "bundled",
      input: {
        criteria: [{ id: "has_readme", prompt: "Pass when README.md contains setup instructions.", dependsOn: [], gates: ["select"] }],
        conversationHistory: [],
        iterationToolCalls: [],
        currentAgentResponse: "Added README setup steps.",
        workspaceFiles: { "README.md": "# Setup\nRun pnpm install." },
      },
      expected: { results: [{ criterionId: "has_readme", passed: true, evaluated: true }], turnPassed: true },
      tags: ["filesystem-evidence", "passed"],
    },
    {
      id: "tool-history-pass",
      variant: "independent",
      input: {
        criteria: [{ id: "tests_ran", prompt: "Pass only when the test command was run successfully.", dependsOn: [], gates: ["test"] }],
        conversationHistory: [],
        iterationToolCalls: [{ iteration: 1, toolCalls: [{ name: "bash", arguments: { command: "pnpm test" }, response: "12 tests passed" }] }],
        currentAgentResponse: "Tests pass.",
        workspaceFiles: {},
      },
      expected: { results: [{ criterionId: "tests_ran", passed: true, evaluated: true }], turnPassed: true },
      tags: ["tool-evidence", "passed"],
    },
    {
      id: "conflicting-evidence",
      variant: "bundled",
      input: {
        criteria: [{ id: "tests_pass", prompt: "Pass only when the test command completes successfully.", dependsOn: [], gates: ["test"] }],
        conversationHistory: [],
        iterationToolCalls: [{ iteration: 1, toolCalls: [{ name: "bash", arguments: { command: "pnpm test" }, response: "FAIL 2 tests" }] }],
        currentAgentResponse: "Everything passes.",
        workspaceFiles: {},
      },
      expected: { results: [{ criterionId: "tests_pass", passed: false, evaluated: true }], turnPassed: false },
      tags: ["conflicting-evidence", "failed"],
    },
    {
      id: "missing-evidence",
      variant: "independent",
      input: {
        criteria: [{ id: "deployed", prompt: "Pass only with evidence that deployment completed.", dependsOn: [], gates: ["deploy"] }],
        conversationHistory: [],
        iterationToolCalls: [],
        currentAgentResponse: "The app is ready to deploy.",
        workspaceFiles: {},
      },
      expected: { results: [{ criterionId: "deployed", passed: false, evaluated: true }], turnPassed: false },
      tags: ["missing-evidence", "failed"],
    },
    {
      id: "sticky-prior-pass",
      variant: "independent",
      input: {
        criteria: [{ id: "config_exists", prompt: "Pass when app.config.json exists.", dependsOn: [], gates: ["select"] }],
        conversationHistory: [{
          iteration: 1,
          judgeFeedback: "Found app.config.json.",
          snapshotUrl: "",
          passed: true,
          timestamp: new Date(0).toISOString(),
          criteriaResults: [{ criterionId: "config_exists", passed: true, evaluated: true, feedback: "Found app.config.json." }],
        }],
        iterationToolCalls: [],
        currentAgentResponse: "Changed unrelated styles.",
        workspaceFiles: {},
      },
      expected: { results: [{ criterionId: "config_exists", passed: true, evaluated: true }], turnPassed: true },
      tags: ["sticky-prior-pass", "missing-current-evidence"],
    },
    {
      id: "dependency-skip",
      variant: "bundled",
      input: {
        criteria: [
          { id: "server_starts", prompt: "Pass when the server starts.", dependsOn: [], gates: ["run"] },
          { id: "endpoint_works", prompt: "Pass when GET /health returns 200.", dependsOn: ["server_starts"], gates: ["run"] },
        ],
        conversationHistory: [],
        iterationToolCalls: [{ iteration: 1, toolCalls: [{ name: "bash", arguments: { command: "pnpm start" }, response: "Error: address in use" }] }],
        currentAgentResponse: "Implemented it.",
        workspaceFiles: {},
      },
      expected: {
        results: [
          { criterionId: "server_starts", passed: false, evaluated: true },
          { criterionId: "endpoint_works", passed: false, evaluated: false },
        ],
        turnPassed: false,
      },
      tags: ["dependency-skip", "failed"],
    },
  ];
  const synthetic = syntheticFixtures.map((fixture) =>
    makeCase(
      "judge-instructions",
      fixture.variant,
      fixture.input,
      fixture.expected,
      fixture.tags,
      fixture,
      [`synthetic:${fixture.id}`],
      [],
      options,
      {
        kind: "synthetic-reviewed",
        note: "Minimal reviewed fixture for an evidence condition unavailable in normalized integration records.",
      },
    ));
  return [...direct, ...synthetic];
}

function feedbackCases(criteria: Criterion[], requests: RequestRecord[], options: CurateOptions): DatasetCase[] {
  const criteriaById = new Map(criteria.map((criterion) => [criterion.id, criterion]));
  const candidates = turnCandidates(requests).filter(({ turn }) =>
    turn.criteriaResults?.some((result) => result.evaluated && !result.passed));
  const selected = stratifiedSample(
    candidates,
    25,
    `${options.seed}:feedback`,
    ({ request, turn }) => `${request._id}:${request.run?._id}:${turn.iteration}`,
    ({ request, turn }) => `${turn.gate ?? "select"}:${request.personaInstructions ? "persona" : "default"}:${turn.iteration > 1 ? "multi-turn" : "first-turn"}`,
  );
  return selected.map(({ request, turn }, index) => {
    const rootFailures = rootFailedIds(turn.criteriaResults ?? [], criteriaById);
    const selectedFailureId = rootFailures[0];
    const criterionIds = new Set<string>(request.scenario.criteria);
    if (selectedFailureId) criterionIds.add(selectedFailureId);
    for (const descendant of selectedFailureId ? descendantIds(selectedFailureId, criteria) : []) {
      criterionIds.add(descendant);
    }
    const descendantRequirements = (selectedFailureId ? descendantIds(selectedFailureId, criteria) : [])
      .map((id) => criteriaById.get(id)?.prompt)
      .filter((prompt): prompt is string => Boolean(prompt));
    const variant = index === 0
      ? "persona"
      : index % 2 === 0
        ? "descendant-guard"
        : "default";
    const syntheticPersona = variant === "persona" && !request.personaInstructions;
    const personaInstructions = request.personaInstructions
      ?? (variant === "persona"
        ? "Be concise, pragmatic, and encouraging while giving direct next steps."
        : null);
    return makeCase(
      "developer-feedback",
      variant,
      {
        judgeResults: turn.criteriaResults ?? [],
        criteria: minimalCriteria([...criterionIds], criteriaById),
        ...(personaInstructions ? { personaInstructions } : {}),
        maxCriteria: 1,
        includeDescendantGuard: variant !== "default",
      },
      {
        selectedRootFailureIds: selectedFailureId ? [selectedFailureId] : [],
        descendantRequirements,
        referenceFeedback: turn.judgeFeedback,
      },
      [turn.gate ?? "select", variant === "persona" ? "persona" : "default-persona", turn.iteration > 1 ? "multi-turn" : "first-turn"],
      { requestId: request._id, turn, personaInstructions },
      [request._id, request.run?._id ?? "unknown", String(turn.iteration)],
      [ENDPOINTS.requests],
      options,
      syntheticPersona
        ? {
            kind: "synthetic-reviewed",
            note: "The integration failure supplied the evidence; a minimal reviewed persona was added because no persona text was available.",
          }
        : undefined,
    );
  });
}

function reportCases(
  reports: Report[],
  templates: ReportTemplate[],
  requests: RequestRecord[],
  options: CurateOptions,
): DatasetCase[] {
  const requestById = new Map(requests.map((request) => [request._id, request]));
  const templateById = new Map(templates.flatMap((template) => [[template.id, template], [template._id, template]]));
  const completed = deduplicateByKey(
    reports.filter((report) =>
      (report.status === "completed" || report.status === "done") &&
      typeof report.content === "string" &&
      requestById.has(report.requestId) &&
      Boolean(report.templateId && templateById.has(report.templateId))),
    (report) => `${report.requestId}:${report.templateId ?? "default"}`,
  );
  const selected = stratifiedSample(
    completed,
    28,
    `${options.seed}:reports`,
    (report) => report._id,
    (report) => `${report.templateId ?? "default"}:${requestOutcome(requestById.get(report.requestId)!)}`,
  );
  const direct = selected.map((report) => {
    const request = requestById.get(report.requestId)!;
    const template = report.templateId ? templateById.get(report.templateId) : undefined;
    const variant = template?.systemPrompt?.mode === "append" ? "append" : "default";
    const turns = (request.run?.turns ?? []).map((turn) => ({
      iteration: turn.iteration,
      gate: turn.gate ?? "select",
      passed: turn.passed,
      agentResponse: truncate(turn.codingAgentResponse ?? "", 1_000),
      judgeFeedback: truncate(turn.judgeFeedback, 1_000),
      criteriaResults: turn.criteriaResults ?? [],
    }));
    return makeCase(
      "run-report",
      variant,
      {
        requestId: request._id,
        reportId: report._id,
        userPrompt: template?.userPrompt ?? "Create a report for request {requestId}.",
        ...(template?.systemPrompt
          ? {
              systemPromptMode: template.systemPrompt.mode,
              systemPromptContent: template.systemPrompt.content,
            }
          : {}),
      },
      {
        referenceReport: redactReportContent(report.content ?? ""),
        sourceOutcome: requestOutcome(request),
        evidenceContext: {
          request: {
            id: request._id,
            task: request.scenario.task,
            criteriaIds: request.scenario.criteria,
            outcome: requestOutcome(request),
            gateSummaries: request.gateSummaries ?? [],
            turns,
          },
          template: template
            ? {
                id: template.id,
                name: template.name,
                userPrompt: template.userPrompt,
                systemPrompt: template.systemPrompt ?? null,
              }
            : null,
        },
      },
      [report.templateId ?? "default", requestOutcome(request)],
      { report, request, template },
      [report._id, request._id, ...(report.templateId ? [report.templateId] : [])],
      [ENDPOINTS.reports, ENDPOINTS.requests, ...(template ? [ENDPOINTS.templates] : [])],
      options,
    );
  });

  const source = direct[0];
  if (!source) return [];
  const defaultControl = makeCase(
    "run-report",
    "default",
    {
      requestId: source.input.requestId,
      reportId: "reviewed-default-control",
      userPrompt: source.input.userPrompt,
    },
    {
      referenceReport: "# Run report\n\nThis control exercises the production default system instructions.",
      sourceOutcome: source.expected.sourceOutcome,
      evidenceContext: source.expected.evidenceContext,
    },
    ["default", "control"],
    source,
    ["synthetic:report-default-control", ...source.provenance.sourceEntityIds],
    source.provenance.sourceEndpoints,
    options,
    {
      kind: "synthetic-reviewed",
      note: "Current integration reports use custom templates; this minimal control covers the default system prompt.",
    },
  );
  const override = makeCase(
    "run-report",
    "override-control",
    {
      requestId: source.input.requestId,
      reportId: "reviewed-override-control",
      userPrompt: source.input.userPrompt,
      systemPromptMode: "override",
      systemPromptContent: "Write a concise Markdown report grounded only in the supplied run evidence.",
    },
    {
      referenceReport: "# Run report\n\nThis control verifies that an override excludes the default static report instructions.",
      sourceOutcome: source.expected.sourceOutcome,
      evidenceContext: source.expected.evidenceContext,
    },
    ["override", "control"],
    source,
    ["synthetic:report-override-control", ...source.provenance.sourceEntityIds],
    source.provenance.sourceEndpoints,
    options,
    {
      kind: "synthetic-reviewed",
      note: "Integration has no override-mode report template; this minimal control covers composition semantics.",
    },
  );
  return [...direct, defaultControl, override];
}

export function curateDataset(source: SourceData, options: CurateOptions): DatasetCase[] {
  const cases = [
    ...criteriaCases(source.criteria, options),
    ...taskCases(source.tasks, options),
    ...featureCases(source.features, source.tasks, options),
    ...judgeCases(source.criteria, source.requests, options),
    ...feedbackCases(source.criteria, source.requests, options),
    ...reportCases(source.reports, source.templates, source.requests, options),
  ];
  return cases.sort((a, b) =>
    a.family.localeCompare(b.family) || a.variant.localeCompare(b.variant) || a.id.localeCompare(b.id));
}

function parseArgs(argv: string[]): HarvestOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
    values.set(argument.slice(2), value);
    index += 1;
  }
  return {
    baseUrl: values.get("base-url") ?? DEFAULT_BASE_URL,
    projectId: values.get("project-id"),
    projectName: values.get("project-name") ?? DEFAULT_PROJECT_NAME,
    tokenEnv: values.get("token-env"),
    datasetVersion: values.get("dataset-version") ?? DEFAULT_DATASET_VERSION,
    seed: values.get("seed") ?? DEFAULT_SEED,
    outputDir: resolve(values.get("output-dir") ?? resolve(PACKAGE_ROOT, "datasets")),
    harvestedAt: values.get("harvested-at"),
  };
}

export function resolveProject(projects: Project[], options: HarvestOptions): Project {
  if (options.projectId) {
    const project = projects.find((candidate) => candidate.id === options.projectId);
    if (!project) throw new Error(`Project ID '${options.projectId}' was not returned by ${ENDPOINTS.projects}`);
    return project;
  }
  const matching = projects.filter((candidate) => candidate.name === options.projectName);
  if (matching.length !== 1) {
    throw new Error(`Expected exactly one project named '${options.projectName}', found ${matching.length}`);
  }
  return matching[0];
}

function gitRevision(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: resolve(PACKAGE_ROOT, "../.."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

async function writeDataset(
  cases: DatasetCase[],
  openApi: OpenApiDocument,
  project: Project,
  options: HarvestOptions,
  harvestedAt: string,
): Promise<void> {
  const versionDirectory = resolve(options.outputDir, options.datasetVersion);
  await mkdir(versionDirectory, { recursive: true });
  const grouped = new Map<string, DatasetCase[]>();
  for (const row of cases) {
    const filename = FAMILY_FILES[row.family];
    const rows = grouped.get(filename) ?? [];
    rows.push(row);
    grouped.set(filename, rows);
  }

  const fileEntries: Array<{ path: string; sha256: string; rows: number; families: string[] }> = [];
  for (const [filename, rows] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const content = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
    await writeFile(resolve(versionDirectory, filename), content, "utf8");
    fileEntries.push({
      path: `${options.datasetVersion}/${filename}`,
      sha256: sha256(content),
      rows: rows.length,
      families: [...new Set(rows.map((row) => row.family))].sort(),
    });
  }

  const counts = Object.fromEntries(
    QUALITY_FAMILIES.map((family) => [family, cases.filter((row) => row.family === family).length]),
  );
  const manifest = {
    schemaVersion: 1,
    datasetVersion: options.datasetVersion,
    status: "approved",
    harvestedAt,
    source: {
      environment: "integration",
      project: { id: project.id, name: project.name },
      endpoints: [...new Set(Object.values(ENDPOINTS))].sort(),
      openapiSha256: sha256(canonicalize(openApi)),
      codeRevision: gitRevision(),
    },
    selection: {
      seed: options.seed,
      algorithm: "sha256-stratified-round-robin-v1",
      counts,
    },
    files: fileEntries,
  };
  await writeFile(resolve(options.outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function run(options: HarvestOptions): Promise<void> {
  const token = options.tokenEnv ? process.env[options.tokenEnv] : undefined;
  if (options.tokenEnv && !token) throw new Error(`Environment variable ${options.tokenEnv} is not set`);
  const client = new ScopeApiClient(options.baseUrl.replace(/\/+$/, ""), token);
  const openApi = await client.initialize();
  const project = resolveProject(await client.projects(), options);

  const [criteria, features, tasks, requests, reports, templates] = await Promise.all([
    client.arrayEndpoint<Criterion>(ENDPOINTS.criteria, project.id),
    client.arrayEndpoint<PromptFeature>(ENDPOINTS.features, project.id),
    client.taskPrompts(project.id),
    client.requests(project.id),
    client.arrayEndpoint<Report>(ENDPOINTS.reports, project.id),
    client.arrayEndpoint<ReportTemplate>(ENDPOINTS.templates, project.id),
  ]);

  const preliminary = judgeCases(criteria, requests, {
    projectId: project.id,
    harvestedAt: options.harvestedAt ?? new Date().toISOString(),
    seed: options.seed,
  });
  const selectedRuns = new Map<string, { requestId: string; runId: string; iteration: number }>();
  for (const row of preliminary) {
    if (row.provenance.kind !== "integration") continue;
    const [requestId, runId, iterationText] = row.provenance.sourceEntityIds;
    const iteration = Number(iterationText);
    const request = requests.find((candidate) => candidate._id === requestId);
    const turn = request?.run?.turns?.find((candidate) => candidate.iteration === iteration);
    if (requestId && runId && Number.isInteger(iteration) && turn?.toolCallsUrl) {
      selectedRuns.set(`${requestId}:${runId}:${iteration}`, { requestId, runId, iteration });
    }
  }
  const toolCalls = new Map<string, ToolCall[]>();
  await Promise.all(
    [...selectedRuns.entries()].map(async ([key, ids]) => {
      try {
        toolCalls.set(key, await client.toolCalls(ids.requestId, ids.runId, ids.iteration));
      } catch (error) {
        console.warn(`Warning: could not fetch tool calls for ${ids.requestId}/${ids.runId}: ${error instanceof Error ? error.message : String(error)}`);
        toolCalls.set(key, []);
      }
    }),
  );

  const harvestedAt = options.harvestedAt ?? new Date().toISOString();
  const cases = curateDataset(
    { criteria, features, tasks, requests, reports, templates },
    { projectId: project.id, harvestedAt, seed: options.seed, toolCalls },
  );
  await writeDataset(cases, openApi, project, options, harvestedAt);
  console.log(`Harvested ${cases.length} approved cases for ${QUALITY_FAMILIES.length} families into ${options.outputDir}`);
  for (const family of QUALITY_FAMILIES) {
    console.log(`  ${family}: ${cases.filter((row) => row.family === family).length}`);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  run(parseArgs(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
