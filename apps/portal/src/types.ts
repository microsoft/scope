// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Types mirroring the API response shapes (from shared/src/types.ts)

export type RunStatus = "pending" | "queued" | "processing" | "paused" | "done";
export type RunOutcome = "succeeded" | "failed" | "finished";

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface CriterionResult {
  criterionId: string;
  passed: boolean;
  feedback: string;
  evaluated: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  response?: string;
  timestamp?: string;
}

export interface ConversationTurn {
  iteration: number;
  gate?: GateId;
  codingAgentResponse?: string;
  judgeFeedback: string;
  snapshotUrl: string;
  passed: boolean;
  timestamp: string;
  criteriaResults?: CriterionResult[];
  harUrl?: string;
  videoUrls?: string[];
  tokenUsage?: TokenUsage;
  startedAt?: string;
  durationMs?: number;
  toolCalls?: ToolCall[];
  /** Blob storage URL to the per-iteration tool-calls JSONL append blob.
   *  Replaces the inline `toolCalls` array for new runs. */
  toolCallsUrl?: string;
  /** Number of tool calls in `toolCallsUrl` — used for counts/aggregates
   *  without fetching the JSONL blob. */
  toolCallCount?: number;
  aiCallCount?: number;
  atifUrl?: string;
}

export interface Scenario {
  version?: "v1" | "v2";
  task: string;
  criteria: string[];
}

export interface Persona {
  personality: string;
  experience: string;
  verbosity: string;
  type: string;
}

export interface LogEvent {
  timestamp: string;
  level: "info" | "warn" | "error" | "debug";
  source?: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface OsInfo {
  platform: string;
  release: string;
  arch: string;
}

/**
 * Per-attempt mutable state (nested under `Run.run` in API responses since
 * migration 014). Fields here change as a single attempt progresses; fields
 * on the parent `Run` are immutable across attempts.
 */
export interface RunState {
  _id: string;
  attemptNumber: number;
  status: RunStatus;
  outcome?: RunOutcome;
  result?: string;
  error?: string;
  logsUrl?: string;
  turns?: ConversationTurn[];
  workerVersion?: string;
  os?: OsInfo;
  /** Wall-clock time the owning worker last extended visibility for this run's queue message. */
  lastHeartbeatAt?: string;
  /** Identity of the worker process currently processing the run. */
  worker?: { instanceId: string; podName?: string };
  harUrl?: string;
  videoUrls?: string[];
  setupVideoUrls?: string[];
  tokenUsage?: TokenUsage;
  aiCallCount?: number;
  rawChatUrl?: string;
  rawChatFormat?: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt?: string;
  pausedAt?: string;
  resumedAt?: string;
  postProcessorVersion?: number;
  postProcessorStatus?: "queued" | "processing" | "done" | "failed";
}

export interface Run {
  _id: string;
  id: string;
  scenario?: Scenario;
  workerType: string;
  model?: string;
  reasoningEffort?: string;
  agentVersion?: string;
  /** Per-attempt mutable state for the current attempt. */
  run?: RunState;
  maxIterations?: number;
  personaInstructions?: string;
  persona?: Persona;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
  taskPromptId?: string;
  mcpServers?: string[];
  skills?: string[];
  skillRevisions?: string[];
  codebaseRevisionId?: string;
  extensions?: string[];
  priority?: number;
  submissionId?: string;
  profileId?: string;
  profileVersionId?: string;
  /** Resolved AGENTS.md prompt id when an AGENTS.md was supplied. */
  agentsMdPromptId?: string;
  /** Parent AGENTS.md prompt ids forming the AGENTS.md lineage (mutation/merge edges). */
  agentsMdParentIds?: string[];
  gates?: GateConfig[];
  gateSummaries?: GateRunSummary[];
}

export interface CursorPaginatedResponse<T> {
  data: T[];
  limit: number;
  /**
   * Run-count total for the flat list pager / "~N runs total" banner. Omitted
   * in grouped mode, which is measured in groups (not runs) and paginated purely
   * by cursors — so the client drives Next/Prev off `cursors` without a total.
   */
  estimatedTotal?: number;
  cursors: {
    next: string | null;
    prev: string | null;
  };
}

export type GateId = "select" | "build" | "test" | "run" | "deploy";
export type PromptType = GateId | "agents.md";

export interface GateConfig {
  gate: GateId;
  promptId?: string;
  /** Input-only free-text gate prompt; materialized server-side into a typed prompt. */
  promptText?: string;
  criteria: string[];
  maxIterations?: number;
}

export interface GateRunSummary {
  gate: GateId;
  status: "passed" | "failed" | "skipped";
  iterations: number;
}

export const STATUS_LIST: RunStatus[] = [
  "pending",
  "queued",
  "processing",
  "paused",
  "done",
];

export const OUTCOME_LIST: RunOutcome[] = [
  "succeeded",
  "failed",
  "finished",
];

/** Comparison operator for iteration-count filters. */
export type IterationOp = "eq" | "gte" | "lte";

// Criteria types
export interface CriteriaConfig {
  id: string;
  prompt: string;
  dependsOn?: string[];
  gates?: GateId[];
}

export interface CriteriaDocument extends CriteriaConfig {
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
}

export interface CriteriaGraphData {
  nodes: Array<{ id: string; prompt: string; dependsOn: string[]; gates?: GateId[] }>;
  edges: Array<{ source: string; target: string }>;
}

export interface GeneratePromptResponse {
  prompt: string;
  suggestedId: string;
  suggestedParents: string[];
  suggestedChildren: string[];
}

// Prompt Feature types
export interface PromptFeatureConfig {
  id: string;
  prompt: string;
  /** Prompt type this feature applies to (absent ⇒ "select"). */
  type?: PromptType;
}

export interface PromptFeatureDocument extends PromptFeatureConfig {
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
}

export interface PromptFeatureResult {
  featureId: string;
  detected: boolean;
  evaluated: boolean;
}

export interface SuggestedPromptFeature {
  suggestedId: string;
  behavior: string;
  prompt: string;
}

export interface TaskPrompt {
  _id: string;                          // UUIDv5 content-addressed ID
  text?: string;                        // Full task prompt text (absent when blob-backed)
  type?: PromptType;                    // Gate id or "agents.md"; absent ⇒ legacy "select"
  contentBlobUrl?: string;              // Blob reference when body exceeds the inline threshold
  features?: PromptFeatureResult[];     // Detected prompt features
  featuresExtractedAt?: string;         // When features were last extracted
  createdAt: string;
  deletedAt?: string;
}

/** Response shape from feature extraction endpoints */
export interface TaskPromptFeatureExtractionResult {
  taskPromptId?: string;
  features: PromptFeatureResult[];
  featuresExtractedAt?: string;
  suggestedFeatures?: SuggestedPromptFeature[];
  cached: boolean;
}

// Analysis types for statistics dashboard
export interface TaskWorkerGroup {
  task: string;
  taskPromptId: string;
  workerType: string;
  total: number;
  completed: number;
  passed: number;
  rejected: number;
  passAtK: Record<number, number>;  // k -> probability
  successAtT: number[];  // CDF: index i = probability of success at ≤(i+1) iterations
  iterationStats: {
    mean: number;
    stdDev: number;
    min: number;
    max: number;
  } | null;  // null if no passed runs
  durationStats: {
    mean: number;
    stdDev: number;
    min: number;
    max: number;
  } | null;  // Total run duration in ms (null if no timing data)
}

export interface AnalysisResponse {
  groups: TaskWorkerGroup[];
  kValues: number[];
  maxT: number;
  summary: {
    totalRuns: number;
    completedRuns: number;
    passedRuns: number;
    overallPassRate: number;
    avgIterationsToPass: number | null;
  };
  /** Union of all criteria IDs found across all runs (before filtering) */
  availableCriteria: string[];
  /** Criteria IDs that were used to define success (empty = use turn.passed) */
  selectedCriteria: string[];
  /** Union of all detected task-prompt feature IDs across all runs (before filtering) */
  availableFeatures: string[];
  /** Task-prompt feature IDs used to filter runs (empty = no feature filter) */
  selectedFeatures: string[];
  /**
   * True when the analyzed run set was capped to a most-recent-N window to bound
   * server memory. Older runs are excluded from the metrics; the UI shows a banner.
   */
  truncated?: boolean;
  /** The configured run cap (max runs analyzed) — only meaningful when `truncated`. */
  runLimit?: number;
}

// MDP state-transition graph types

/** Per-criterion state within a composite state vector */
export interface MdpCriterionState {
  id: string;
  passed: boolean;
}

/** Per-feature state within a prompt-feature start node */
export interface MdpFeatureState {
  id: string;
  detected: boolean;
}

/** Node type discriminator */
export type MdpNodeType = "prompt-features" | "criteria";

/** A node in the MDP graph — a unique composite state vector */
export interface MdpStateNode {
  /** Canonical string key (e.g. "has_azure:0|has_cloud:1|has_iac:0") */
  id: string;
  /** Sorted criteria states (present on criteria nodes) */
  criteria: MdpCriterionState[];
  /** Sorted feature states (present on prompt-feature start nodes) */
  features?: MdpFeatureState[];
  /** Node type: "prompt-features" for start nodes, "criteria" for state nodes */
  type?: MdpNodeType;
  /** How many times any episode visited this state */
  visits: number;
  /** True for the start state (prompt-features node or synthetic initial) */
  isInitial?: boolean;
  /** True if no outgoing transitions exist (final state of some episodes) */
  isTerminal?: boolean;
}

/** An edge in the MDP graph — a transition between two states */
export interface MdpTransitionEdge {
  source: string;
  target: string;
  /** How many times this specific transition was observed */
  count: number;
  /** Probability: count / total outgoing from source */
  probability: number;
}

/** Full MDP response */
export interface MdpResponse {
  nodes: MdpStateNode[];
  edges: MdpTransitionEdge[];
  /** Total number of episodes (runs) that contributed */
  episodeCount: number;
  /** All criteria IDs found across all runs (before filtering) */
  availableCriteria: string[];
  /** Criteria IDs used for projection (empty = all) */
  selectedCriteria: string[];
  /** All prompt feature IDs found across all runs */
  availablePromptFeatures: string[];
  /** Prompt feature IDs used for filtering (empty = all) */
  selectedFeatures: string[];
  /** ISO timestamp of when this was computed — used for incremental polling */
  computedAt: string;
}

// Bulk re-submit overrides
export interface BulkResubmitOverrides {
  profileId?: string | null;
  workerType?: string;
  model?: string | null;
  reasoningEffort?: string | null;
  maxIterations?: number | null;
  mcpServers?: string[] | null;
  skillRevisions?: string[] | null;
  extensions?: string[] | null;
}

// Bulk re-submit response
export interface BulkResubmitResponse {
  submitted: number;
  failed: string[];
  newIds: string[];
}

// Report types
export type ReportStatus = "pending" | "generating" | "completed" | "failed";

export interface Reporter {
  id: string;
  name: string;
  gitHash: string;
  model: string;
  agentId: string;
  agentVersion: string;
}

export interface Report {
  _id: string;
  id: string;
  requestId: string;
  task?: string;
  reporter?: Reporter;
  content?: string;
  status: ReportStatus;
  error?: string;
  insightReferences?: InsightReference[];
  templateId?: string;
  createdAt: string;
  updatedAt?: string;
}

export const REPORT_STATUS_LIST: ReportStatus[] = [
  "pending",
  "generating",
  "completed",
  "failed",
];

export interface BulkReportStatus {
  [requestId: string]: { reportId: string; status: ReportStatus };
}

export interface ReportSummary {
  total: number;
  pending: number;
  generating: number;
  completed: number;
  failed: number;
}

export interface BulkReportSummary {
  [requestId: string]: ReportSummary;
}

// =============================================================================
// Report Template types
// =============================================================================

export type ReportTriggerType = "always" | "criteria" | "taskPrompt" | "promptFeature";

export interface AlwaysTrigger {
  type: "always";
}

export interface CriteriaTrigger {
  type: "criteria";
  criteriaIds: string[];
  match?: "any" | "all";
}

export interface TaskPromptTrigger {
  type: "taskPrompt";
  taskPromptIds: string[];
}

export interface PromptFeatureTrigger {
  type: "promptFeature";
  featureIds: string[];
  match?: "any" | "all";
}

export type ReportTrigger =
  | AlwaysTrigger
  | CriteriaTrigger
  | TaskPromptTrigger
  | PromptFeatureTrigger;

export interface ReportTemplateSystemPrompt {
  mode: "append" | "override";
  content: string;
}

export interface ReportTemplate {
  _id: string;
  id: string;
  name: string;
  description?: string;
  userPrompt: string;
  systemPrompt?: ReportTemplateSystemPrompt;
  trigger?: ReportTrigger;
  model?: string;
  timeoutMs?: number;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
}

// =============================================================================
// Key Manager types
// =============================================================================

export type KeyType =
  "github-pat-classic" | "github-pat-fine-grained" | "github-oauth" | "github-oauth-cookie-state" | "anthropic-api-key" | "anthropic-oauth" | "azure-ai-foundry";

export type KeyCapability =
  "github-models" | "github-public-api" | "copilot-models" | "copilot-sdk" | "copilot-cli" | "claude-code-cli" | "anthropic-api" | "azure-ai-inference";

export type KeyValidationStatus =
  | "valid"
  | "invalid"
  | "expired"
  | "error"
  | "unknown";

export interface KeyDocument {
  _id: string;
  type: KeyType;
  capabilities: KeyCapability[];
  secretName: string;
  expiresAt?: string;
  lastValidatedAt?: string;
  lastValidationStatus: KeyValidationStatus;
  lastValidationError?: string;
  enabled: boolean;
  comment?: string;
  acquireCount: number;
  lastAcquiredAt?: string;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
  /** Non-secret Azure AI Foundry deployment / model name. */
  model?: string;
}

export interface KeyValidationResult {
  status: KeyValidationStatus;
  scopes?: string[];
  capabilities?: KeyCapability[];
  expiresAt?: string;
  error?: string;
  rateLimit?: {
    limit: number;
    remaining: number;
    reset: string;
  };
}

export interface CreateKeyRequest {
  type: KeyType;
  value: string;
  expiresAt?: string;
  enabled?: boolean;
  comment?: string;
}

export interface UpdateKeyRequest {
  enabled?: boolean;
  expiresAt?: string | null;
  comment?: string | null;
  /** Azure AI Foundry deployment / model name; null clears the override. */
  model?: string | null;
}

export const KEY_TYPE_LABELS: Record<KeyType, string> = {
  "github-pat-classic": "GitHub PAT (classic)",
  "github-pat-fine-grained": "GitHub PAT (fine-grained)",
  "github-oauth": "GitHub OAuth",
  "github-oauth-cookie-state": "GitHub OAuth Cookie State",
  "anthropic-api-key": "Anthropic API Key",
  "anthropic-oauth": "Anthropic OAuth (Subscription)",
  "azure-ai-foundry": "Azure AI Foundry",
};

export const KEY_CAPABILITY_LABELS: Record<KeyCapability, string> = {
  "github-models": "GitHub Models",
  "github-public-api": "GitHub Public API",
  "copilot-models": "Copilot Models",
  "copilot-sdk": "Copilot SDK",
  "copilot-cli": "Copilot CLI",
  "claude-code-cli": "Claude Code CLI",
  "anthropic-api": "Anthropic API",
  "azure-ai-inference": "Azure AI Inference",
};

export const KEY_CAPABILITY_DESCRIPTIONS: Record<KeyCapability, string> = {
  "github-models": "Access AI models hosted on GitHub (GPT-4o, Claude, etc.)",
  "github-public-api": "Read public repository contents (used for skill discovery and resolution)",
  "copilot-models": "List models available via the Copilot API (OAuth only, PATs rejected)",
  "copilot-sdk": "Use the Copilot SDK to make LLM requests programmatically",
  "copilot-cli": "Run GitHub Copilot in the CLI for code suggestions",
  "claude-code-cli": "Run Claude Code as an agentic coding assistant",
  "anthropic-api": "Access the Anthropic REST API (model scanning, direct API calls)",
  "azure-ai-inference": "Chat-completion inference against an Azure AI Foundry deployment",
};

/**
 * Static matrix of which capabilities each key type can provide.
 * Mirrors the server-side deriveCapabilities() logic for display purposes.
 * Conditional capabilities (require specific scopes) are included — actual
 * detection happens during validation.
 */
export const KEY_TYPE_EXPECTED_CAPABILITIES: Record<KeyType, KeyCapability[]> = {
  "github-pat-classic": ["github-public-api", "copilot-sdk", "copilot-cli"],
  "github-pat-fine-grained": ["github-public-api", "github-models"],
  "github-oauth": ["github-public-api", "github-models", "copilot-models", "copilot-sdk", "copilot-cli"],
  "github-oauth-cookie-state": [],
  "anthropic-api-key": ["claude-code-cli", "anthropic-api"],
  "anthropic-oauth": ["claude-code-cli"],
  "azure-ai-foundry": ["azure-ai-inference"],
};

export const ALL_CAPABILITIES: KeyCapability[] = [
  "github-models", "github-public-api", "copilot-models", "copilot-sdk", "copilot-cli", "claude-code-cli", "anthropic-api", "azure-ai-inference",
];

// Account types
export type AccountType = "github";

export interface AccountDocument {
  _id: string;
  type: AccountType;
  secretName: string;
  enabled: boolean;
  comment?: string;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
}

export interface CreateAccountRequest {
  type: AccountType;
  username: string;
  password: string;
  totpUri: string;
  enabled?: boolean;
  comment?: string;
}

export interface UpdateAccountRequest {
  enabled?: boolean;
  comment?: string | null;
  username?: string;
  password?: string;
  totpUri?: string;
}

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  github: "GitHub",
};

// Agent version entry (embedded in CodingAgent)
export interface AgentVersion {
  agentVersion: string;
  workerVersion: string;
  components: Record<string, string>;
  gitCommit: string;
  buildTime: string;
  imageTag: string;
  queueName?: string;
  status: "active" | "retired";
  createdAt: string;
}

// Agent capabilities declared at the worker level
export interface AgentCapabilities {
  supportsReasoningEffort?: boolean;
  supportsMcpServers?: boolean;
  supportsSkills?: boolean;
  supportsExtensions?: boolean;
}

// Coding Agent types
export interface CodingAgent {
  _id: string;
  name: string;
  description?: string;
  modelProvider?: string;
  supportedModels: string[];
  defaultModel?: string;
  available?: boolean;
  capabilities?: AgentCapabilities;
  versions?: AgentVersion[];
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
}

export function getActiveAgentVersions(agent: CodingAgent): AgentVersion[] {
  return (agent.versions ?? []).filter(
    (version) => version.status === "active" && (version.queueName?.trim().length ?? 0) > 0,
  );
}

export function isAgentAvailable(agent: CodingAgent): boolean {
  return agent.available === true
    && !agent.deletedAt
    && getActiveAgentVersions(agent).length > 0;
}

export function isAgentVersionAvailable(
  agent: CodingAgent | undefined,
  agentVersion?: string,
): boolean {
  return !!agent
    && isAgentAvailable(agent)
    && (!agentVersion
      || getActiveAgentVersions(agent).some(
        (version) => version.agentVersion === agentVersion,
      ));
}

// MCP Server types
export type McpTransportType = "sse" | "http" | "stdio";
export type McpSessionMode = "stateful" | "stateless";

export interface McpServerHeader {
  name: string;
  value: string;
}

export interface McpServerDocument {
  _id: string;
  name: string;
  type: McpTransportType;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: McpServerHeader[];
  sessionMode?: McpSessionMode;
  version?: string;
  description?: string;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
}

export interface CreateMcpServerRequest {
  _id: string;
  name: string;
  type: McpTransportType;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: McpServerHeader[];
  sessionMode?: McpSessionMode;
  version?: string;
  description?: string;
}

export interface UpdateMcpServerRequest {
  name?: string;
  type?: McpTransportType;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: McpServerHeader[];
  sessionMode?: McpSessionMode;
  version?: string;
  description?: string;
}

// =============================================================================
// Insight types
// =============================================================================

/** Reference from a report to an insight */
export interface InsightReference {
  insightId: string;
  referencedAt: string;
  isNew: boolean;
}

/** Insight entity */
export interface Insight {
  _id: string;
  id: string;
  title: string;
  /** Markdown-formatted detailed observation */
  description: string;
  category?: string;
  tags?: string[];
  upvotes: number;
  downvotes: number;
  blocked: boolean;
  referenceCount: number;
  createdBy: "agent" | "user";
  sourceReportId?: string;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
}

/** Insight enriched with reference metadata (when fetched via report) */
export interface InsightWithReference extends Insight {
  referencedAt?: string;
  isNew?: boolean;
}

// =============================================================================
// Model types
// =============================================================================

/** A scanned model tracked across agents and providers */
export interface ModelCapabilities {
  reasoningEffort?: string[];
  toolCalls?: boolean;
  vision?: boolean;
  streaming?: boolean;
  adaptiveThinking?: boolean;
  maxThinkingBudget?: number;
}

export interface Model {
  _id: string;
  modelId: string;
  provider: string;
  agentId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  disappearedAt?: string;
  providerAvailableFrom?: string;
  providerEndOfLife?: string;
  metadata?: Record<string, unknown>;
  capabilities?: ModelCapabilities;
}

// =============================================================================
// Skill types
// =============================================================================

/** Origin of a skill */
export type SkillOrigin = "skills-sh" | "manual";

/** An imported skill */
export interface SkillDocument {
  _id: string;
  source: string;
  skillName: string;
  name: string;
  origin: SkillOrigin;
  description?: string;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
}

/** A resolved skill revision (immutable) */
export interface SkillRevisionDocument {
  _id: string;
  ref: string;
  source: string;
  skillName: string;
  commitHash: string;
  name: string;
  description?: string;
  license?: string;
  compatibility?: string;
  allowedTools?: string;
  metadata?: Record<string, string>;
  content: string;
  archiveUrl?: string;
  validationWarnings?: string[];
  resolvedAt: string;
}

/** Unified search result */
export interface SkillSearchResult {
  id: string;
  name: string;
  source: string;
  description?: string;
  internal: boolean;
  installs?: number;
}

/** A skill discovered by enumerating a GitHub repo's well-known directories */
export interface SkillDiscoveryResult {
  skillName: string;
  skillPath: string;
  name?: string;
  description?: string;
  existsInLibrary?: boolean;
  currentRevisionCommitSha?: string;
  latestUpstreamCommitSha?: string;
  updateAvailable?: boolean;
  lastImportedAt?: string;
}

// =============================================================================
// Codebase types
// =============================================================================

/** The source a codebase revision is captured from. */
export type CodebaseSourceType = "git" | "archive";

/** A first-class codebase entity (mutable pointer/metadata). */
export interface CodebaseDocument {
  _id: string;
  slug: string;
  name: string;
  description?: string;
  sourceType: CodebaseSourceType;
  source?: string;
  defaultBranch?: string;
  revisionCounter: number;
  latestRevisionId?: string;
  creator?: string;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
}

/** An immutable, incremental codebase revision (snapshot). */
export interface CodebaseRevisionDocument {
  _id: string;
  codebaseId: string;
  slug: string;
  revisionNumber: number;
  ref: string;
  sourceType: CodebaseSourceType;
  source?: string;
  requestedRef?: string;
  resolvedCommitSha?: string;
  commitTimestamp?: string;
  originalFilename?: string;
  contentSha256?: string;
  archiveUrl: string;
  sizeBytes?: number;
  fileCount?: number;
  creator?: string;
  resolvedAt: string;
  createdAt: string;
  /**
   * Present only on resolve/upload responses: true when the revision was reused
   * (deduplicated) because nothing changed, false when newly created.
   */
  deduplicated?: boolean;
}

// =============================================================================
// VS Code extension types
// =============================================================================

export type ExtensionOrigin = "marketplace" | "manual";

export interface ExtensionDocument {
  _id: string;
  publisher: string;
  name: string;
  description?: string;
  origin: ExtensionOrigin;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
}

export interface ExtensionSearchResult {
  id: string;
  name: string;
  publisher: string;
  description?: string;
  internal: boolean;
  version?: string;
}

export interface ExtensionVersionInfo {
  version: string;
  preRelease: boolean;
  lastUpdated: string;
}

// =============================================================================
// Feature flag types
// =============================================================================

/** A runtime feature flag controlling portal feature visibility */
export interface FeatureFlag {
  key: string;
  label: string;
  enabled: boolean;
  updatedAt: string;
}

// =============================================================================
// Profile types
// =============================================================================

/** Profile identity document (mutable) */
export interface ProfileDocument {
  _id: string;
  name: string;
  description?: string;
  latestVersion: number;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
}

/** Profile version document (immutable snapshot) */
export interface ProfileVersionDocument {
  _id: string;
  profileId: string;
  version: number;
  workerType: string;
  model: string;
  reasoningEffort?: string;
  agentVersion?: string;
  mcpServers?: string[];
  skillRevisions?: string[];
  extensions?: string[];
  createdAt: string;
}

/** Profile with its latest (or specified) version embedded */
export interface ProfileWithVersion extends ProfileDocument {
  version: ProfileVersionDocument;
}

// --- Runs grouping types (mirrored from shared) ---

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
  reasoningEffort?: string;
  agentVersion?: string;
  platform?: string;
  mcpServers?: string[];
  skillRevisions?: string[];
  extensions?: string[];
  status?: RunStatus;
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

/** One selectable value + full-dataset count for a Runs-list filter dimension. */
export interface RunFacetBucket {
  value: string;
  count: number;
}

/** Server-computed facet counts for the Runs list filter rail (issue #1138). */
export interface RunFacetsResponse {
  total: number;
  facets: {
    workerType: RunFacetBucket[];
    status: RunFacetBucket[];
    outcome: RunFacetBucket[];
    model: RunFacetBucket[];
    os: RunFacetBucket[];
    priority: RunFacetBucket[];
    agentVersion: RunFacetBucket[];
    profileId: RunFacetBucket[];
  };
}

/** The categorical dimensions exposed by the facets endpoint. */
export type RunFacetDimension = keyof RunFacetsResponse["facets"];

/** Sentinel value matching rows that are missing a categorical field ("(Unknown)"). */
export const EMPTY_FILTER_VALUE = "__empty__";

/** Server-side sort fields for the Runs list. */
export type RunSortField =
  | "created"
  | "updated"
  | "priority"
  | "worker"
  | "status"
  | "id"
  | "duration";
export type RunSortDir = "asc" | "desc";

// --- Projects ---

/**
 * A project as returned by the API (`GET /projects`). A project is the
 * top-level, unscoped container that every scoped entity carries a `projectId`
 * for. There is no "default" project. Dates arrive as ISO strings over JSON;
 * `id` mirrors `_id`.
 */
export interface Project {
  _id: string;
  /** Mirror of `_id` added by the API response. */
  id?: string;
  name: string;
  description?: string;
  creator?: string;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
}

/** Body for creating a project (`POST /projects`). */
export interface CreateProjectRequest {
  name: string;
  description?: string;
  creator?: string;
}

/** Body for updating a project (`PATCH /projects/:id`). */
export interface UpdateProjectRequest {
  name?: string;
  description?: string;
}
