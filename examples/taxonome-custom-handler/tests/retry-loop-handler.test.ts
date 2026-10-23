// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import type { DeterministicHandlerInput } from "taxonomy-engine";
import {
  retryHandler,
  retryOutputSchema,
} from "../src/handlers/index.js";

/** Creates one complete deterministic input with explicit retry evidence. */
function retryInput(sourceId?: string): DeterministicHandlerInput {
  return {
    taxonomy: {
      schema_version: "scope/taxonomy/v1",
      id: "fixture",
      version: "1.0.0",
      digest: "fixture",
      surfaces: [{
        id: "surface-mcp",
        label: "MCP",
      }],
    },
    atif: {
      schema_version: "ATIF-v1.7",
      session_id: "session-test",
      agent: { name: "fixture" },
      steps: [{
        step_id: 1,
        source: "agent",
        message: "Retry completed.",
        tool_calls: [{
          tool_call_id: "retry-1",
          function_name: "account/query",
          arguments: {},
          extra: {
            scope: {
              ...(sourceId ? { source_id: sourceId } : {}),
              response: { recovered: true, attempts: 3 },
            },
          },
        }],
      }],
      extra: {
        scope: {
          schema_version: "scope.atif-extension.v1",
          trajectory_state: "complete",
          available_sources: sourceId
            ? [{
              id: sourceId,
              label: "account/query",
              surface_id: "surface-mcp",
            }]
            : [],
        },
      },
    },
  };
}

describe("retry-loop deterministic handler", () => {
  it("returns a typed positive occurrence for attributed retry evidence", () => {
    const result = retryHandler.evaluate(
      retryInput("account/query"),
      { min_attempts: 2 },
    );

    expect(retryOutputSchema.parse(result)).toEqual({
      state: "completed",
      observed: true,
      occurrences: [{
        source: {
          id: "account/query",
          label: "account/query",
          surface_id: "surface-mcp",
        },
        related_turns: [1],
        tool_call_id: "retry-1",
        attempts: 3,
      }],
    });
  });

  it("returns indeterminate when positive evidence lacks attribution", () => {
    expect(retryHandler.evaluate(
      retryInput(),
      { min_attempts: 2 },
    )).toEqual({
      state: "indeterminate",
      reason: "Recovered retry evidence is missing source attribution.",
    });
  });
});
