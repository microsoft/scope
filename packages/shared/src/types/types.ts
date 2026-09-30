// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { McpServerConfig } from './mcp.js';
import type { SkillConfig } from './skill.js';
import type { ExtensionConfig } from './extension.js';
import type { ResourceBinding, ResourceConfig, ResourceRunOutcome } from './resource.js';
import type { ToolCall } from '../har/types.js';

// Re-export ToolCall so consumers can import from types
export type { ToolCall } from '../har/types.js';

// --- Gates (multi-phase evaluation pipeline) ---
// See docs/design/gates.md. Gates are hard-coded and run strictly in order.

/** The ordered, hard-coded set of evaluation gates. */
export const GATES = ["select", "build", "test", "run", "deploy"] as const;

/** A single gate identifier. */
export type GateId = (typeof GATES)[number];

/** Ordered execution sequence — array index defines run order. */
export const GATE_ORDER: readonly GateId[] = GATES;

/** Static, human-facing metadata for a gate. */
export interface GateMetadata {
  id: GateId;
  label: string;
  description: string;
}

/** Hard-coded metadata for every gate, keyed by id. */
export const GATE_METADATA: Record<GateId, GateMetadata> = {
  select: {
    id: "select",
    label: "Requirements",
    description: "Agent implements the task (current behaviour).",
  },
  build: {
    id: "build",
    label: "Build",
    description: "Project builds / compiles successfully.",
  },
  test: {
    id: "test",
    label: "Test",
    description: "Tests pass.",
  },
  run: {
    id: "run",
    label: "Run",
    description: "App runs / serves correctly.",
  },
  deploy: {
    id: "deploy",
    label: "Deploy",
    description: "Deploys to the target environment.",
  },
};

/** True when `value` is a valid gate id. */
export function isGateId(value: unknown): value is GateId {
  return typeof value === "string" && (GATES as readonly string[]).includes(value);
}

/** Non-gate prompt kinds — prompt types that are not pipeline gates. */
export const NON_GATE_PROMPT_TYPES = ["agents.md"] as const;

/** Every prompt-type discriminator: the gates plus non-gate kinds. */
export const PROMPT_TYPES = [...GATES, ...NON_GATE_PROMPT_TYPES] as const;

/**
 * A prompt's type discriminator. Either a gate id — the prompt that drives that
 * gate, where `select` is the request's task prompt — or a non-gate kind such
 * as `agents.md` (an AGENTS.md instruction file delivered into the agent
 * workspace). Absent on a document ⇒ legacy `'select'`.
 */
export type PromptType = (typeof PROMPT_TYPES)[number];

/** True when `value` is a valid prompt type (a gate id or a non-gate kind). */
export function isPromptType(value: unknown): value is PromptType {
  return typeof value === "string" && (PROMPT_TYPES as readonly string[]).includes(value);
}

/**
 * Per-gate configuration on a request. Describes which prompt drives the gate,
 * which criteria are evaluated for it, and the gate's iteration budget.
 */
export interface GateConfig {
  /** Which gate this configures. */
  gate: GateId;
  /**
   * Prompt entity id (`prompt.type` must === `gate`). For the Select gate this
   * is the request's task prompt (`taskPromptId`).
   *
   * Optional on **input**: callers may instead supply `promptText` (free text),
   * which the submit handler content-addresses into a typed prompt and resolves
   * to this id. Persisted gate configs always carry the resolved `promptId`.
   */
  promptId?: string;
  /**
   * Input-only convenience: a free-text gate prompt. When present at submit it
   * is materialized via `taskPromptStore.findOrCreate(text, gate)` and
   * supersedes any `promptId`. It is stripped from the persisted config once
   * resolved, so it never appears on a stored/running gate.
   */
  promptText?: string;
  /**
   * Criterion ids evaluated for THIS gate. Must contain ≥1 id unless
   * `maxIterations === 1` (a pass-through gate that auto-passes with no judge).
   */
  criteria: string[];
  /** Per-gate iteration budget. Falls back to the request-level default. */
  maxIterations?: number;
}

/** Per-gate execution outcome recorded on a run for cheap querying. */
export interface GateRunSummary {
  gate: GateId;
  status: "passed" | "failed" | "skipped";
  /** Number of iterations actually executed for this gate. */
  iterations: number;
}

/** LLM token usage counters for a single interaction */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// Multi-turn conversation turn (one coding + judge iteration)
export interface ConversationTurn {
  iteration: number;
  /** Which gate this turn belongs to. Absent on legacy turns (treated as
   *  "select"). Lets the UI/history group turns per gate. */
  gate?: GateId;
  /** The coding agent's final assistant message for this iteration.
   *  Optional: workers may omit it when no response text could be extracted
   *  from the agent (e.g. the chat result envelope contained no recognizable
   *  assistant text). The full transcript is still available via rawChatUrl /
   *  harUrl. */
  codingAgentResponse?: string;
  judgeFeedback: string;
  snapshotUrl: string;
  passed: boolean;
  timestamp: Date;
  criteriaResults?: CriterionResult[];  // Per-criterion breakdown from DAG evaluation
  harUrl?: string;         // Blob storage URL to the HAR file for this turn
  videoUrls?: string[];    // Blob storage URLs to session recording videos for this turn
  tokenUsage?: TokenUsage;  // LLM token usage for this iteration
  startedAt?: Date;        // When this iteration began
  durationMs?: number;     // Wall-clock duration of this iteration in milliseconds
  toolCalls?: ToolCall[];   // @deprecated — legacy inline tool calls. New writes use `toolCallsUrl` + `toolCallCount`. Kept for backwards-compatible reads.
  /** Blob storage URL to the per-iteration tool-calls JSONL append blob
   *  (`{requestId}/runs/{runId}/iteration-{n}/tool-calls.jsonl`). Replaces
   *  the inline `toolCalls` array so unbounded tool-call lists no longer
   *  contribute to the CosmosDB 2 MB document-size limit. */
  toolCallsUrl?: string;
  /** Number of tool calls in `toolCallsUrl` — kept on the turn so consumers
   *  can render counts/aggregates without fetching the JSONL blob. */
  toolCallCount?: number;
  aiCallCount?: number;    // Number of AI completion API calls made during this iteration
  rawChatUrl?: string;     // Blob storage URL to the raw chat transcript export
  rawChatFormat?: string;  // Format identifier for the raw chat export
  /** Blob storage URL to the JSON-serialized chat result envelope returned
   *  by the chat command (VS Code's `IChatAgentResult2` shape for the
   *  electron worker). Carries internal metadata — timings, tool-call
   *  rounds/results, summaries, resolved model, response id — that is NOT
   *  the assistant's prose (see `codingAgentResponse` for that). Useful for
   *  post-hoc diagnostics; not meant for end-user display. */
  chatResultUrl?: string;
  /** Format identifier for the chat result envelope
   *  (e.g. 'IChatAgentResult2' for the electron worker). */
  chatResultFormat?: string;
  /** Blob storage URL to the ATIF trajectory JSON for this iteration
   *  (`{requestId}/runs/{runId}/iteration-{N}/trajectory.json`). Generated by
   *  the post-processor worker after the run completes. */
  atifUrl?: string;
}

// Multi-turn configuration constants
export const MULTI_TURN_DEFAULTS = {
  MAX_ITERATIONS: 10,
  ITERATION_TIMEOUT_MS: 30 * 60 * 1000, // 30 minutes
} as const;

// --- Persona & Scenario types (mirrors prototype config schema) ---

export type Personality = "demanding" | "friendly";
export type Experience = "junior" | "senior";
export type Verbosity = "brief" | "moderate";
export type UserType = "traditional" | "ai_assisted" | "vibe";

export interface Persona {
  personality: Personality;
  experience: Experience;
  verbosity: Verbosity;
  type: UserType;
}

export interface Scenario {
  task: string;
  criteria: string[];  // criteria IDs
}

export interface TraitDescriptions {
  personality: Record<Personality, string>;
  experience: Record<Experience, string>;
  verbosity: Record<Verbosity, string>;
  type: Record<UserType, string>;
}

// Agent version entry — embedded in CodingAgentDocument.versions[]
export interface AgentVersion {
  agentVersion: string;                  // PK — version prefix from versions.env (e.g. "copilot-0.0.415")
  workerVersion: string;                 // Latest deployed build = image tag (e.g. "copilot-0.0.415-20260318T163740Z-44d16d6")
  components: Record<string, string>;    // Component env vars (e.g. { COPILOT_CLI_VERSION: "0.0.415" })
  gitCommit: string;                     // Short SHA of the build
  buildTime: string;                     // Build timestamp (e.g. "20260318T163740Z")
  imageTag: string;                      // Full image tag (same as workerVersion)
  queueName?: string;                    // Queue this version listens on; legacy records may omit it
  status: "active" | "retired";
  createdAt: Date;
}

// Capabilities declared by a coding agent (worker-level features)
export interface AgentCapabilities {
  supportsReasoningEffort?: boolean;  // Whether the worker can pass reasoning effort to the underlying agent
  supportsMcpServers?: boolean;       // Whether the worker can configure MCP servers
  supportsSkills?: boolean;           // Whether the worker can consume installed agent skills
  supportsExtensions?: boolean;       // Whether the worker can install VS Code extensions
  supportsResources?: boolean;        // Whether the worker provisions resources (setup/teardown) before the agent runs
}

// Coding agent definition stored in MongoDB
export interface CodingAgentDocument {
  _id: string;               // Agent ID (e.g. "coder-acp-copilot")
  name: string;              // Display name
  description?: string;
  modelProvider?: string;     // Model provider (e.g. "github-copilot", "anthropic") — used by scanners to discover agents
  supportedModels: string[];  // Empty array = model selection disabled
  defaultModel?: string;
  available?: boolean;        // Only explicit true makes this agent available for new submissions
  capabilities?: AgentCapabilities;  // Worker-level capabilities
  versions?: AgentVersion[];  // Registered agent versions (embedded array)
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date;           // Soft-delete timestamp
}

// Model document stored in MongoDB — tracks lifecycle of scanned models
export interface ModelDocument {
  _id: string;                     // Compound: "{agentId}:{modelId}" for uniqueness
  modelId: string;                 // Model identifier (e.g. "gpt-4.1")
  provider: string;                // Provider identifier (e.g. "github-copilot", "anthropic")
  agentId: string;                 // Which coding agent this model was discovered for
  firstSeenAt: Date;               // First time our scanner discovered this model
  lastSeenAt: Date;                // Last scan where this model was still present
  disappearedAt?: Date;            // Set when a previously-seen model is no longer returned by the provider
  providerAvailableFrom?: Date;    // Provider-reported availability date
  providerEndOfLife?: Date;        // Provider-reported planned end-of-life / deprecation date
  metadata?: Record<string, unknown>; // Additional provider-specific metadata
}

export interface OsInfo {
  platform: string;   // os.platform() → "linux", "darwin", "win32"
  release: string;    // os.release() → kernel/OS version string
  arch: string;       // os.arch() → "x64", "arm64"
}

// Request document stored in MongoDB
export interface RequestDocument {
  _id: string;  // UUID as _id (for CosmosDB sharding compatibility)
  projectId: string;             // FK → ProjectDocument._id (immutable scope; set at submit)
  scenario: Scenario;            // The task + criteria (source of truth)
  workerType: string;
  model?: string;              // Model selected for this run
  reasoningEffort?: string;    // User-selected reasoning effort level (informational / validated)
  createdAt: Date;
  updatedAt?: Date;
  // Multi-turn fields
  maxIterations?: number;
  personaInstructions?: string;  // Resolved persona prose (from traits.yaml)
  persona?: Persona;             // Original persona object for traceability
  deletedAt?: Date;              // Soft-delete timestamp (null/absent = active)
  taskPromptId?: string;            // Materialized UUIDv5 of scenario.task (FK → TaskPromptDocument._id)
  /**
  * FK → TaskPromptDocument._id of an AGENTS.md-typed prompt to deliver into
  * the agent's workspace for this run. When set, the worker writes the
  * resolved content to `<workspace>/AGENTS.md` before the run starts.
  */
  agentsMdPromptId?: string;
  /**
  * Lineage edges for the AGENTS.md candidate: the parent AGENTS.md prompt ids
  * this candidate was derived from. Empty/absent = root (seed); one entry =
  * reflective mutation; two entries = merge. Recorded on the request so the
  * full lineage DAG can be reconstructed by querying related requests.
  */
  agentsMdParentIds?: string[];
  mcpServers?: string[];          // MCP server slugs selected for this run
  skillRevisions?: string[];      // Skill revision refs (e.g. "vercel-labs/agent-skills/my-skill@a1b2c3d")
  codebaseRevisionId?: string;    // FK → CodebaseRevisionDocument._id — seeds the workspace before the agent starts
  /**
   * Resolved resource bindings, in setup order.
   *
   * The revision is pinned at submit time so the run stays reproducible after the
   * resource is edited, and `params` is stored **fully resolved** (defaults, then
   * profile presets, then run-supplied values) rather than as a diff — a run must
   * be explainable from its own document without re-reading a revision whose
   * defaults may since have been superseded.
   *
   * Deliberately one grouped array rather than parallel `resourceRevisionIds` and
   * `resourceParams` arrays: parallel lists would have to stay the same length and
   * order forever, an invariant nothing enforces and any future writer can break.
   *
   * Shares its name with `RunState.resources`, which records the *outcome* of the
   * same list keyed by the same `revisionId`. One is what was asked for, the other
   * is what happened.
   */
  resources?: ResourceBinding[];
  extensions?: string[];           // VS Code extension IDs selected for this run (e.g. "ms-python.python")
  agentVersion?: string;          // Agent software version prefix (e.g. "copilot-0.0.415") — FK → AgentVersion.agentVersion
  profileId?: string;             // FK → ProfileDocument._id (the profile lineage)
  profileVersionId?: string;      // FK → ProfileVersionDocument._id (exact version used)
  submissionId?: string;           // FK → SubmissionDocument._id
  /** Scheduling priority. Higher = processed first. Default: 0. */
  priority: number;
  /**
   * Per-gate configuration for the multi-phase evaluation pipeline. When
   * absent, the request is normalised to a single Select gate from
   * `scenario.criteria` + `maxIterations` + `taskPromptId` (see
   * docs/design/gates.md §4.3). Gates run in `GATE_ORDER`.
   */
  gates?: GateConfig[];
  /**
   * Per-gate execution summary, populated as the run progresses. Derived
   * from `run.turns` but stored explicitly for cheap querying.
   */
  gateSummaries?: GateRunSummary[];
  /**
   * Per-attempt mutable state. Migration 014 nests per-attempt fields
   * under this object; new submissions populate it on insert.
   */
  run?: RunState;
}

// Log event for real-time streaming and persistence
export interface LogEvent {
  timestamp: string;
  level: "info" | "warn" | "error" | "debug";
  source?: string;
  message: string;
  data?: Record<string, unknown>;
}

// Queue message payload
export interface QueueMessagePayload {
  requestId: string;
  /**
   * Optional run ID that identifies a specific attempt within the request.
   *
   * When set (post run-retry-attempts rollout), workers should verify that
   * the message's `runId` matches `request.run._id` before processing — if
   * it doesn't, the message is stale (a retry has since started a new
   * attempt) and should be acked and discarded.
   *
   * When omitted, treat as targeting the current `request.run`.
   */
  runId?: string;
}

/**
 * RunState — represents one execution attempt of a request.
 *
 * Per-attempt mutable state is split out from RequestDocument so retries can
 * preserve a history of previous attempts (in the `runs` collection) while the
 * request itself keeps its stable identity and immutable configuration.
 *
 * The current (latest) attempt is embedded in the request document as
 * `RequestDocument.run`. When a request is retried, the previous `run` is
 * snapshotted to the `runs` collection (as a RunHistoryDocument) and a fresh
 * RunState is created for the new attempt.
 *
 * `_id` is unique per attempt — when demoted to history it becomes the
 * `runs` collection's document `_id`. Reusing the request's `_id` for the
 * first attempt's `RunState._id` keeps existing artifact blob paths
 * (`{runId}/iteration-N/...`) valid without rewriting blob storage.
 */
export interface RunState {
  _id: string;                              // Unique per attempt
  attemptNumber: number;                    // 1, 2, 3…
  status: "pending" | "queued" | "processing" | "paused" | "done";
  /** Physical queue used for the current dispatch claim. Cleared when the claim
   * is rolled back or accepted for processing. */
  queuedQueueName?: string;
  outcome?: "succeeded" | "failed" | "finished";
  result?: string;
  error?: string;
  /** Machine-readable error classification (e.g. "model_unavailable", "model_discovery_failed", "auth_failed").
   *  Set alongside `error` when the failure has a well-known cause. */
  errorCode?: string;
  /** Full blob URL pointing to this attempt's JSONL log blob in the `logs`
   *  container, e.g. `https://<account>.blob.core.windows.net/logs/{requestId}/runs/{runId}/run.jsonl`.
   *  Set at submit time so the SSE replay endpoint can read it directly from
   *  the document without recomputing storage paths — matching the pattern
   *  used by `harUrl`, `videoUrls`, and `snapshotUrl`. */
  logsUrl?: string;
  updatedAt?: Date;
  startedAt?: Date;                         // When worker picked up this attempt
  finishedAt?: Date;                        // When this attempt reached "done"
  /** When this run was paused (if status = "paused") */
  pausedAt?: Date;
  /** When this run was last resumed from paused state */
  resumedAt?: Date;
  turns?: ConversationTurn[];
  /** Outcome of each resource this run provisioned, in setup order.
   *
   *  Recorded so a run that ended up without the environment it asked for is
   *  visibly different from one that had it. The dangerous failure mode this
   *  guards against is a run that completes, looks valid, and silently had no
   *  MCP tools — a comparison against such a run is meaningless, so it must be
   *  distinguishable after the fact rather than only in the live log. */
  resources?: ResourceRunOutcome[];
  /** Whether MCP servers were actually registered with the gateway for this
   *  run. `false` with a non-empty `mcpServers` on the request means the profile
   *  ran without the tools it was configured with. */
  mcpRegistered?: boolean;
  workerVersion?: string;
  os?: OsInfo;
  /** Wall-clock time of the last heartbeat written by the worker actively
   *  processing this attempt. **Stored in Redis, not Mongo** — the API
   *  enriches this field on response from a Redis MGET so the portal can
   *  show "Last heartbeat: Xs ago". The redelivery handler reads it
   *  directly from Redis to distinguish a real worker crash (stale or
   *  missing) from a spurious Azure Storage Queue redelivery while the
   *  original worker is still alive (fresh). Never persisted to Mongo. */
  lastHeartbeatAt?: Date;
  /** Identity of the worker process currently (or last) handling this
   *  attempt. Stamped at message pickup. `instanceId` is a per-process UUID
   *  generated at worker startup; `podName` comes from `process.env.HOSTNAME`
   *  when running under Kubernetes. Useful for troubleshooting ("which pod
   *  ran this?") and for the redelivery handler's log lines. */
  worker?: {
    instanceId: string;
    podName?: string;
  };
  harUrl?: string;
  videoUrls?: string[];
  setupVideoUrls?: string[];
  tokenUsage?: TokenUsage;
  aiCallCount?: number;
  rawChatUrl?: string;
  rawChatFormat?: string;
  /** Version of the post-processor that last successfully processed this run.
   *  Used by the scheduler to detect runs needing (re-)processing when the
   *  post-processor version advances. */
  postProcessorVersion?: number;
  /** Lifecycle status of post-processing for this run. Prevents duplicate
   *  enqueuing and tracks processing progress. */
  postProcessorStatus?: "queued" | "processing" | "done" | "failed";
}

/**
 * RunHistoryDocument — a previously-completed attempt stored in the `runs`
 * collection. Same shape as RunState plus a back-reference to its request.
 */
export interface RunHistoryDocument extends RunState {
  requestId: string;                        // FK → RequestDocument._id
  projectId: string;                        // FK → ProjectDocument._id (denormalized from request)
}

/**
 * Field names whose values move from `RequestDocument` (top-level, legacy
 * shape) into `RequestDocument.run: RunState` (new shape introduced for
 * the run-retry-attempts feature). Useful for migration scripts and
 * compat code paths.
 */
export const RUN_STATE_FIELD_NAMES = [
  "status",
  "outcome",
  "result",
  "error",
  "updatedAt",
  "turns",
  "workerVersion",
  "os",
  "lastHeartbeatAt",
  "worker",
  "harUrl",
  "videoUrls",
  "setupVideoUrls",
  "tokenUsage",
  "aiCallCount",
  "rawChatUrl",
  "rawChatFormat",
] as const;

// Options passed to worker processor
export interface WorkerProcessorOptions {
  model?: string;
  /** Reasoning effort level to apply (e.g. "low", "medium", "high"). */
  reasoningEffort?: string;
  /** Project scope of the run. Threaded through so workers that resolve
   *  per-project skill revisions (by ref) hit the right project's copy. */
  projectId?: string;
  mcpServerConfigs?: McpServerConfig[];  // Resolved MCP server configurations
  /** Resolved resources to provision before the agent starts and release after
   *  it finishes. Their setup phases publish connection details that are
   *  interpolated into MCP server config and merged into the agent's env. */
  resourceConfigs?: ResourceConfig[];
  skillConfigs?: SkillConfig[];          // Resolved skill configurations for prompt injection
  extensionConfigs?: ExtensionConfig[];  // Resolved VS Code extension configurations for runtime installation
  /** Current iteration number (1-based) for multi-turn runs. Used by the
   *  proxy HAR rotation logic so each iteration gets its own HAR file. */
  iteration?: number;
}

// Result returned by a worker processor
export interface WorkerResult {
  /** The coding agent's text response. Optional: workers omit this when no
   *  final assistant message could be extracted from the chat envelope.
   *  See growth-ecosystems/scope-core#811. */
  response?: string;
  /** Path to the HAR file on disk (for upload to blob storage) */
  harFilePath?: string;
  /** Paths to session recording video files on disk (for upload to blob storage) */
  videoFilePaths?: string[];
  /** LLM token usage extracted from HAR or reported by the agent */
  tokenUsage?: TokenUsage;
  /** Number of AI completion API calls made during this iteration (extracted from HAR) */
  aiCallCount?: number;
  /** Tool calls extracted from the chat transcript export */
  toolCalls?: ToolCall[];
  /** Path to the raw chat transcript export file on disk (for upload to blob storage) */
  rawChatFilePath?: string;
  /** Format identifier for the raw chat export */
  rawChatFormat?: string;
  /** Path on disk to the JSON-serialized chat result envelope (for upload to
   *  blob storage as `chatResultUrl`). The electron worker writes VS Code's
   *  `IChatAgentResult2` here — see growth-ecosystems/scope-core#811 for
   *  why we keep it as a separate blob rather than inlining it. */
  chatResultFilePath?: string;
  /** Format identifier for the chat result envelope (e.g. 'IChatAgentResult2'). */
  chatResultFormat?: string;
}

/** Log function signature used by worker processors. */
export type WorkerLogFn = (level: LogEvent["level"], message: string, data?: Record<string, unknown>) => Promise<void>;

/** Result returned by setup() — carries optional video paths from the setup phase. */
export interface SetupResult {
  videoFilePaths?: string[];
}

// Worker processor interface - each worker implements this
export interface WorkerProcessor {
  readonly workerName: string;
  /** Optional explicit skill layout. Omit to install only to the universal
   * `.agents/skills` location instead of inferring behavior from the worker ID. */
  readonly skillAgentType?: "copilot" | "claude-code";
  /** The workspace directory used by this worker for the current run. When set,
   *  the queue processor uses this instead of the WORKSPACE_PATH env var. */
  readonly workspacePath?: string;
  processMessage(message: string, log: WorkerLogFn, options?: WorkerProcessorOptions): Promise<WorkerResult>;
  /** Return the agent version prefix from versions.env components (e.g. "copilot-0.0.415"). */
  getAgentVersion?(): string;
  /** Return component versions from versions.env (e.g. { COPILOT_CLI_VERSION: "0.0.415" }). */
  getComponentVersions?(): Record<string, string>;
  /** Called once before the first processMessage in a run. Use to acquire expensive resources (e.g. start a long-lived process). */
  setup?(log: WorkerLogFn, options?: WorkerProcessorOptions): Promise<SetupResult | void>;
  /** Called once after the last processMessage in a run. Always called if setup() was called, even on error. */
  teardown?(log: WorkerLogFn): Promise<void>;
  /** Lifecycle observations to persist on the run record. Read after teardown so
   *  a run that ended up without the environment or tools it asked for is
   *  distinguishable after the fact, not only in the live log. */
  getRunObservations?(): { resources?: ResourceRunOutcome[]; mcpRegistered?: boolean };
}

// Base configuration for queue processors
export interface BaseQueueProcessorConfig {
  mongoUri: string;
  mongoDatabase: string;
  mongoCollection: string;
  storageAccountName: string;
  storageConnectionString?: string; // For local Azurite
  queueName: string;
  batchSize: number;
  pollIntervalMs: number;
  redisHost: string;
  redisPort: number;
  redisPassword: string;
}

// Configuration for the coding agent queue processor
export interface QueueProcessorConfig extends BaseQueueProcessorConfig {
  apiBaseUrl?: string; // For auto-triggering report generation via REST API
  tokenManagerUrl?: string; // For resolving MCP server secrets at job dispatch time
  postProcessorQueueName?: string; // Queue name for event-driven post-processor dispatch
}

// --- Enhanced Criteria System types ---

// --- Runs grouping types (shared between API and portal) ---

export type GroupByKey = "none" | "task" | "submissionId" | "profile";

export interface AggregateStats {
  min: number;
  max: number;
  mean: number;
  stdDev: number;
}

export interface GroupUniformValues {
  workerType?: string;
  model?: string;
  agentVersion?: string;
  platform?: string;
  mcpServers?: string[];
  skillRevisions?: string[];
  extensions?: string[];
  status?: "pending" | "processing" | "done";
  submissionId?: string;
  task?: string;
}

export interface GroupAggregates {
  count: number;
  turns: AggregateStats | null;
  duration: AggregateStats | null;
  promptTokens: AggregateStats | null;
  completionTokens: AggregateStats | null;
  llmCalls: AggregateStats | null;
  statusCounts: Record<string, number>;
  outcomeCounts: Record<string, number>;
}

export interface RunGroup {
  key: string;
  label: string;
  runIds: string[];
  aggregates: GroupAggregates;
  uniform: GroupUniformValues;
}

// Criteria definition (loaded from config/criteria/*.yaml for v2 scenarios)
export interface CriteriaConfig {
  id: string;
  prompt: string;
  dependsOn?: string[];  // Optional parent criteria IDs
  /** Gates this criterion is compatible with. Empty/undefined = all gates
   *  (applies only to NEW criteria; legacy rows are backfilled to ["select"]
   *  by migration 018). See docs/design/gates.md §4.2. */
  gates?: GateId[];
}

// Per-criterion result from judge evaluation
export interface CriterionResult {
  criterionId: string;
  passed: boolean;
  feedback: string;
  evaluated: boolean;  // False if skipped due to ancestor failure
}

// Enhanced evaluation result with per-criterion results
export interface DetailedEvaluationResult {
  allPassed: boolean;
  results: CriterionResult[];
  evaluatedIds: Set<string>;
  strategy: 'bundled' | 'independent';
}

// Judge strategy configuration (from environment/ConfigMap)
export interface JudgeStrategyConfig {
  type: 'bundled' | 'independent';
  maxParallelism?: number;  // For independent strategy (default: 3)
}

// Feedback configuration (from environment/ConfigMap)
export interface FeedbackConfig {
  maxCriteria?: number;  // Max failed criteria to include (default: 1)
  includeDescendantGuard?: boolean;  // Avoid hinting at dependent criteria (default: true)
}

// Criteria document stored in MongoDB (extends CriteriaConfig with DB metadata)
export interface CriteriaDocument extends CriteriaConfig {
  projectId: string;  // FK → ProjectDocument._id (immutable scope)
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date;  // Soft-delete timestamp
}

// --- Report System types ---

export type ReportStatus = "pending" | "generating" | "completed" | "failed";

/** Reporter identity — describes what generated the report */
export interface Reporter {
  id: string;            // Hardcoded worker slug, e.g. "report-generator"
  name: string;          // Human-readable, e.g. "Report Generator"
  gitHash: string;       // Build-time GIT_COMMIT
  model: string;         // Runtime REPORT_MODEL, e.g. "gpt-4.1"
  agentId: string;       // Agent platform identifier, e.g. "copilot-sdk"
  agentVersion: string;  // @github/copilot-sdk package version
}

/** Report document stored in MongoDB */
export interface ReportDocument {
  _id: string;           // UUID
  requestId: string;     // FK → RequestDocument._id
  projectId: string;     // FK → ProjectDocument._id (denormalized from request)
  templateId?: string;   // FK → ReportTemplateDocument.id (slug of template that generated this report)
  reporter?: Reporter;   // Set by the worker when it picks up the job
  content?: string;      // Generated markdown report
  status: ReportStatus;
  error?: string;
  insightReferences?: InsightReference[];  // Insights discovered/referenced by this report
  createdAt: Date;
  updatedAt?: Date;
}

/** Queue message payload for report generation */
export interface ReportQueueMessagePayload {
  reportId: string;
}

// --- Report Template System types ---

/** Trigger that fires on every completed run */
export interface AlwaysTrigger {
  type: "always";
}

/** Trigger that matches against scenario criteria IDs */
export interface CriteriaTrigger {
  type: "criteria";
  criteriaIds: string[];
  match?: "any" | "all";  // Default: "any"
}

/** Trigger that matches against exact task prompt IDs (UUIDv5 content-addressed) */
export interface TaskPromptTrigger {
  type: "taskPrompt";
  taskPromptIds: string[];
}

/** Trigger that matches against detected prompt features */
export interface PromptFeatureTrigger {
  type: "promptFeature";
  featureIds: string[];
  match?: "any" | "all";  // Default: "any"
}

/** Discriminated union of all report trigger types */
export type ReportTrigger =
  | AlwaysTrigger
  | CriteriaTrigger
  | TaskPromptTrigger
  | PromptFeatureTrigger;

/** System prompt customization for a report template */
export interface ReportTemplateSystemPrompt {
  mode: "append" | "override";
  content: string;
}

/** Report template document stored in MongoDB */
export interface ReportTemplateDocument {
  _id: string;                           // Auto-generated UUID
  projectId: string;                     // FK → ProjectDocument._id (immutable scope)
  id: string;                            // Human-readable slug (e.g. "default", "failure-analysis")
  name: string;                          // Display name
  description?: string;
  userPrompt: string;                    // REQUIRED — the instruction sent to the agent
  systemPrompt?: ReportTemplateSystemPrompt;  // OPTIONAL — customize base system prompt
  trigger?: ReportTrigger;               // OPTIONAL — omit = always trigger
  model?: string;                        // OPTIONAL — LLM model override (falls back to REPORT_MODEL env var)
  timeoutMs?: number;                    // OPTIONAL — session timeout override in ms (falls back to SESSION_TIMEOUT_MS env var)
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date;                      // Soft-delete timestamp
}

// --- Insights System types ---

/** Reference from a report to an insight */
export interface InsightReference {
  insightId: string;     // FK → InsightDocument._id
  referencedAt: Date;    // When the reference was made
  isNew: boolean;        // True if this report created the insight, false if referencing existing
}

/** Insight document stored in MongoDB */
export interface InsightDocument {
  _id: string;           // UUID
  projectId: string;     // FK → ProjectDocument._id (from source report, or ?projectId= if user-created)
  title: string;         // Short summary (one line)
  /** Markdown-formatted detailed observation */
  description: string;
  category?: string;     // Grouping tag (e.g. "agent-behavior", "criteria-handling", "tool-usage")
  tags?: string[];       // Free-form tags for search
  upvotes: number;       // Simple counter (default 0)
  downvotes: number;     // Simple counter (default 0)
  blocked: boolean;      // Whether this insight is blocked (default false)
  referenceCount: number; // How many reports reference this insight
  createdBy: "agent" | "user";  // Who initially created the insight
  sourceReportId?: string;      // FK → ReportDocument._id (if agent-created)
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date;      // Soft-delete timestamp
}

// --- Task Prompt System types ---
// Task prompts are immutable, content-addressed entities identified by UUIDv5(text, namespace).
// Runs reference task prompts via a materialized taskPromptId derived from scenario.task.

/** Task prompt document stored in MongoDB. Immutable — text cannot be changed after creation. */
export interface TaskPromptDocument {
  _id: string;                          // Fresh UUID (per-project copy)
  projectId: string;                    // FK → ProjectDocument._id (immutable scope; per-project copy)
  /**
   * Content-address key: `computePromptId(type, text)`. Stable across projects
   * for identical `(type, text)`, so the same prompt text yields the same
   * `keyId` in every project. Uniqueness is enforced per-project via a
   * `{ projectId, keyId }` unique index — distinct projects get distinct `_id`s
   * for the same `keyId`.
   */
  keyId: string;
  /**
   * Inline prompt body. Present when the body is small enough to store in
   * Mongo (≤ PROMPT_INLINE_MAX_BYTES). Mutually exclusive with
   * `contentBlobUrl` — exactly one is set. Optional so large bodies can live
   * in blob storage instead.
   */
  text?: string;
  /**
   * Blob reference to the prompt body when it exceeds the inline size
   * threshold. Mutually exclusive with `text`. The body is fetched via
   * `resolvePromptText` server-side.
   */
  contentBlobUrl?: string;
  /** Which gate this prompt drives, or a non-gate kind (e.g. `agents.md`).
   *  Absent ⇒ legacy `'select'` (the request's task prompt). */
  type?: PromptType;
  features?: PromptFeatureResult[];     // Detected prompt features
  featuresExtractedAt?: Date;           // When features were last extracted
  createdAt: Date;
  deletedAt?: Date;                     // Soft-delete timestamp
}

// --- Prompt Features System types ---
// Prompt features describe detectable characteristics of a task prompt
// (analogous to criteria which describe detectable characteristics of a codebase)

/** Prompt feature definition (loaded from config/prompt-features/*.yaml) */
export interface PromptFeatureConfig {
  id: string;
  prompt: string;
  /**
   * Which prompt type this feature applies to. Absent ⇒ `'select'` (backward
   * compatible). Feature extraction only considers features whose `type`
   * matches the prompt being extracted.
   */
  type?: PromptType;
}

/** Prompt feature document stored in MongoDB (extends PromptFeatureConfig with DB metadata) */
export interface PromptFeatureDocument extends PromptFeatureConfig {
  projectId: string;  // FK → ProjectDocument._id (immutable scope)
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date;  // Soft-delete timestamp
}

/** Per-feature result from LLM extraction */
export interface PromptFeatureResult {
  featureId: string;
  detected: boolean;
  evaluated: boolean;  // False if skipped due to ancestor not detected
}

/** A prompt feature suggested by the LLM during extraction (not yet in the registry) */
export interface SuggestedPromptFeature {
  suggestedId: string;
  behavior: string;
  prompt: string;
}

// =============================================================================
// Feature flag types
// =============================================================================

/** A runtime feature flag controlling portal feature visibility */
export interface FeatureFlagDocument {
  /** Unique identifier for the feature (e.g. "mcp", "models", "agents", "tokens") */
  key: string;
  /** Human-readable display label */
  label: string;
  /** Whether the feature is enabled and visible in the portal */
  enabled: boolean;
  /** Last time this flag was modified */
  updatedAt: Date;
}
