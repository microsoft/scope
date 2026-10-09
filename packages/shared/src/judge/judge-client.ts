// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ConversationTurn, CriterionResult, GateId } from "../types/types.js";
import { withRetry } from "../utils/retry.js";
import { stripTrailingSlashes } from "../utils/strings.js";

/**
 * Request payload for the judge service's /api/v1/evaluate endpoint.
 */
export interface JudgeEvaluateRequest {
  snapshotUrl: string;
  criteria: string[];
  conversationHistory: ConversationTurn[];
  personaInstructions?: string;
  requestId?: string;  // Enables the judge to publish real-time progress via Redis
  /** Which gate is being evaluated (select | build | test | run | deploy). Defaults to select. */
  gate?: GateId;
  /** Blob URL of this iteration's captured tool calls/outputs (build/test/run output). */
  toolCallsUrl?: string;
  /** The run's project — scopes the judge's criteria resolution to that project. */
  projectId?: string;
  /**
   * 1-based number of the iteration currently being judged. Lets the judge
   * label the current iteration's tool calls when assembling the cumulative
   * run-wide tool-call history (prior iterations come from
   * `conversationHistory[].toolCallsUrl`). Optional for backward compatibility;
   * defaults to `conversationHistory.length + 1` when omitted. See scope #1255.
   */
  iteration?: number;
  /**
   * The coding agent's assistant message (prose) for the iteration being
   * judged. Carried inline so the judge can expose it to criteria via the
   * read-only `read_agent_response` tool. Required for grading no-code / Q&A
   * scenarios where the deliverable *is* the agent's response. The current
   * turn is not persisted until after the judge returns, so this is the only
   * way the judge can see the in-flight response. See scope #1136.
   */
  currentAgentResponse?: string;
}

/**
 * Response from the judge service's /api/v1/evaluate endpoint.
 */
export interface JudgeEvaluateResponse {
  passed: boolean;
  feedback: string;
  criteriaResults?: CriterionResult[];  // Per-criterion results for DAG status tracking
}

export interface JudgeClientOptions {
  /** Timeout in ms for evaluate requests (default: JUDGE_CLIENT_TIMEOUT env or 600000 = 10 minutes) */
  timeoutMs?: number;
  /** Maximum retry attempts on timeout/transient errors (default: JUDGE_CLIENT_RETRIES env or 2) */
  maxRetries?: number;
}

/**
 * Error thrown when the judge service itself fails to run an evaluation — e.g. an
 * HTTP 5xx, or a Copilot SDK <-> CLI protocol version mismatch inside the judge.
 *
 * This is deliberately distinct from a normal "criteria not met" outcome (which is
 * returned as `{ passed: false }`, not thrown): it signals a judge infrastructure /
 * deployment / version problem where the agent's output was never actually assessed.
 * Callers should surface it differently from a genuine evaluation failure.
 */
export class JudgeInfrastructureError extends Error {
  readonly isInfrastructure = true as const;
  readonly httpStatus?: number;
  readonly detail?: string;
  /** True when the underlying cause is an SDK<->CLI ACP protocol version mismatch. */
  readonly isVersionMismatch: boolean;

  constructor(
    message: string,
    opts: { httpStatus?: number; detail?: string; isVersionMismatch?: boolean } = {}
  ) {
    super(message);
    this.name = "JudgeInfrastructureError";
    this.httpStatus = opts.httpStatus;
    this.detail = opts.detail;
    this.isVersionMismatch = opts.isVersionMismatch ?? false;
  }
}

/**
 * Detects the Copilot SDK<->CLI protocol version mismatch signature in a judge
 * error body. This surfaces from inside @github/copilot-sdk (not our code) when the
 * bundled CLI negotiates a different ACP protocol version than the SDK expects.
 */
function isProtocolVersionMismatch(body: string): boolean {
  return /protocol version mismatch|SDK expects version|protocolVersion/i.test(body);
}

/** Default timeout for judge evaluate requests (10 minutes) */
const DEFAULT_JUDGE_CLIENT_TIMEOUT = 10 * 60 * 1000;
/** Default retry attempts for judge evaluate requests */
const DEFAULT_JUDGE_CLIENT_RETRIES = 2;

/**
 * Returns true if the error is a timeout, transient network failure, or a
 * transient judge-side 5xx that warrants a retry of the judge evaluation.
 *
 * A `JudgeInfrastructureError` with `httpStatus >= 500` means the judge service
 * itself blipped (e.g. a restart, a transient upstream failure) rather than the
 * agent's output failing a criterion; the evaluate POST is effectively
 * idempotent, so retrying is safe. We deliberately do NOT retry version
 * mismatches: those are a deployment/version problem that won't self-heal
 * within the retry window.
 *
 * For transport-level failures, undici throws `TypeError: fetch failed` where
 * `error.message` is literally just `"fetch failed"` and the real reason (e.g.
 * `ECONNRESET`, `socket hang up`) lives in `error.cause` (its `.message` and/or
 * `.code`). We therefore match `"fetch failed"` explicitly and fold the cause's
 * message and code into the searched haystack so those transient transport
 * failures become retryable. See scope #1317.
 */
export function isRetryableJudgeError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof JudgeInfrastructureError) {
    return (error.httpStatus ?? 0) >= 500 && !error.isVersionMismatch;
  }
  const msg = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? error.cause : undefined;
  const causeMsg = cause instanceof Error ? cause.message : cause ? String(cause) : "";
  const causeCode =
    cause && typeof cause === "object" && "code" in cause
      ? String((cause as { code?: unknown }).code)
      : "";
  const haystack = `${msg} ${causeMsg} ${causeCode}`;
  return (
    haystack.includes("fetch failed") ||
    haystack.includes("The operation was aborted") ||
    haystack.includes("TimeoutError") ||
    haystack.includes("abort") ||
    haystack.includes("ECONNRESET") ||
    haystack.includes("ECONNREFUSED") ||
    haystack.includes("ETIMEDOUT") ||
    haystack.includes("socket hang up") ||
    haystack.includes("network")
  );
}

/**
 * Client for calling the judge REST API from coding workers.
 */
export class JudgeClient {
  private baseUrl: string;
  private timeoutMs: number;
  private maxRetries: number;

  constructor(baseUrl: string, options?: JudgeClientOptions) {
    this.baseUrl = stripTrailingSlashes(baseUrl);
    this.timeoutMs = options?.timeoutMs
      ?? parseInt(process.env.JUDGE_CLIENT_TIMEOUT || String(DEFAULT_JUDGE_CLIENT_TIMEOUT));
    this.maxRetries = options?.maxRetries
      ?? parseInt(process.env.JUDGE_CLIENT_RETRIES || String(DEFAULT_JUDGE_CLIENT_RETRIES));
  }

  /**
   * Calls the judge service to evaluate a workspace snapshot against criteria.
   * Retries on timeout and transient network errors with exponential backoff.
   */
  async evaluate(request: JudgeEvaluateRequest): Promise<JudgeEvaluateResponse> {
    const url = `${this.baseUrl}/api/v1/evaluate`;
    const criteriaCount = request.criteria.length;

    console.log(
      `[JudgeClient] Evaluating ${criteriaCount} criteria (timeout: ${this.timeoutMs}ms, retries: ${this.maxRetries})`
    );

    return withRetry(
      () => this.doEvaluate(url, request),
      {
        maxRetries: this.maxRetries,
        baseDelayMs: 5_000,
        maxDelayMs: 30_000,
        isRetryable: isRetryableJudgeError,
        onRetry: (error, attempt) => {
          const msg = error instanceof Error ? error.message : String(error);
          console.warn(
            `[JudgeClient] Evaluate attempt ${attempt} failed (retrying): ${msg.substring(0, 200)}`
          );
        },
      }
    );
  }

  private async doEvaluate(url: string, request: JudgeEvaluateRequest): Promise<JudgeEvaluateResponse> {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "unknown error");

      // Distinguish judge infrastructure/version failures from a real evaluation.
      // A non-2xx response means the judge never produced a criteria verdict.
      if (isProtocolVersionMismatch(errorBody)) {
        throw new JudgeInfrastructureError(
          `Judge infrastructure error (HTTP ${response.status}): the judge service's Copilot SDK and CLI report incompatible ACP protocol versions. ` +
            `This is a judge deployment/version problem — the agent's output was not evaluated. ` +
            `Align @github/copilot-sdk with the bundled @github/copilot CLI in the judge image. Detail: ${errorBody}`,
          { httpStatus: response.status, detail: errorBody, isVersionMismatch: true }
        );
      }

      if (response.status >= 500) {
        throw new JudgeInfrastructureError(
          `Judge infrastructure error (HTTP ${response.status}): the judge service failed to complete the evaluation. ` +
            `This is a judge-side problem, not a criteria failure. Detail: ${errorBody}`,
          { httpStatus: response.status, detail: errorBody }
        );
      }

      throw new Error(
        `Judge evaluation failed (HTTP ${response.status}): ${errorBody}`
      );
    }

    const result = (await response.json()) as JudgeEvaluateResponse;

    if (typeof result.passed !== "boolean" || typeof result.feedback !== "string") {
      throw new Error(
        `Invalid judge response: expected {passed: boolean, feedback: string}, got ${JSON.stringify(result)}`
      );
    }

    return {
      passed: result.passed,
      feedback: result.feedback,
      criteriaResults: result.criteriaResults,
    };
  }

  /**
   * Health check for the judge service.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
