// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ConversationTurn, CriterionResult } from "@scope/core";

/**
 * Request payload for the judge service's /api/v1/evaluate endpoint.
 */
export interface JudgeEvaluateRequest {
  snapshotUrl: string;
  criteria: string[];
  conversationHistory: ConversationTurn[];
  personaInstructions?: string;
  requestId?: string;  // Enables the judge to publish real-time progress via Redis
}

/**
 * Response from the judge service's /api/v1/evaluate endpoint.
 */
export interface JudgeEvaluateResponse {
  passed: boolean;
  feedback: string;
  criteriaResults?: CriterionResult[];  // Per-criterion results for DAG status tracking
}

/**
 * Client for calling the judge REST API from coding workers.
 */
export class JudgeClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    // Strip trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /**
   * Calls the judge service to evaluate a workspace snapshot against criteria.
   */
  async evaluate(request: JudgeEvaluateRequest): Promise<JudgeEvaluateResponse> {
    const url = `${this.baseUrl}/api/v1/evaluate`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(5 * 60 * 1000), // 5 minute timeout per evaluation
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "unknown error");
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
