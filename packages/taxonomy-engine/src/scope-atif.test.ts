// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { createHandlerRegistry } from "./handlers.js";
import { parseScopeAtif, validateScopeAtif } from "./scope-atif.js";
import { loadTaxonomy } from "./taxonomy.js";

const plainAtif = {
  schema_version: "ATIF-v1.7",
  session_id: "scope-atif-test",
  agent: { name: "test-agent", version: "1.0.0" },
  steps: [
    { step_id: 1, source: "user", message: "Inspect the configured source." },
  ],
};

async function taxonomy() {
  return loadTaxonomy(
    new URL("../fixtures/test-taxonomy.yaml", import.meta.url).pathname,
    { handlers: createHandlerRegistry() },
  );
}

describe("extra.scope ATIF validation", () => {
  it("defaults plain ATIF to complete without inventing sources or discoveries", () => {
    const parsed = parseScopeAtif(plainAtif);

    expect(parsed.extra?.scope).toEqual({
      schema_version: "scope.atif-extension.v1",
      trajectory_state: "complete",
      available_sources: [],
    });
    expect(parsed.steps[0].extra?.scope?.discoveries).toBeUndefined();
  });

  it("preserves explicit partial/unknown state and treats availability separately from discovery", async () => {
    const parsed = parseScopeAtif({
      ...plainAtif,
      extra: {
        scope: {
          schema_version: "scope.atif-extension.v1",
          trajectory_state: "partial",
          available_sources: [{
            id: "skill-a",
            label: "Skill A",
            surface_id: "surface-skills",
          }],
        },
      },
    });

    validateScopeAtif(parsed, await taxonomy());
    expect(parsed.extra?.scope?.trajectory_state).toBe("partial");
    expect(parsed.steps[0].extra?.scope?.discoveries).toBeUndefined();
  });

  it("preserves strict machine-readable tool input validation evidence", async () => {
    const parsed = parseScopeAtif({
      ...plainAtif,
      steps: [{
        step_id: 1,
        source: "agent",
        message: "Calling a source.",
        tool_calls: [{
          tool_call_id: "call-1",
          function_name: "source/query",
          arguments: { count: "many" },
          extra: {
            scope: {
              input_validation: {
                status: "invalid",
                issues: [{
                  code: "invalid_type",
                  path: "$.count",
                  message: "Expected a number.",
                }],
              },
            },
          },
        }],
      }],
    });

    expect(parsed.steps[0].tool_calls?.[0].extra?.scope?.input_validation)
      .toEqual({
        status: "invalid",
        issues: [{
          code: "invalid_type",
          path: "$.count",
          message: "Expected a number.",
        }],
      });
    expect(() => parseScopeAtif({
      ...plainAtif,
      steps: [{
        step_id: 1,
        source: "agent",
        message: "Invalid evidence.",
        tool_calls: [{
          tool_call_id: "call-1",
          function_name: "source/query",
          arguments: {},
          extra: {
            scope: {
              input_validation: { status: "invalid", issues: [] },
            },
          },
        }],
      }],
    })).toThrow();
  });

  it("rejects unknown surfaces, ungrounded discoveries, call links, and non-monotonic steps", async () => {
    const loaded = await taxonomy();
    const withScope = (steps: unknown[], availableSources: unknown[] = []) =>
      parseScopeAtif({
        ...plainAtif,
        steps,
        extra: {
          scope: {
            schema_version: "scope.atif-extension.v1",
            trajectory_state: "unknown",
            available_sources: availableSources,
          },
        },
      });

    expect(() => validateScopeAtif(withScope(plainAtif.steps, [{
      id: "source-a",
      label: "Source A",
      surface_id: "unknown-surface",
    }]), loaded)).toThrow(/unknown surface/);
    expect(() => validateScopeAtif(withScope([{
      ...plainAtif.steps[0],
      extra: {
        scope: {
          discoveries: [{ source_id: "missing", extension_point: "missing" }],
        },
      },
    }]), loaded)).toThrow(/undeclared source/);
    expect(() => validateScopeAtif(withScope([{
      ...plainAtif.steps[0],
      observation: { results: [{ source_call_id: "missing", content: "none" }] },
    }]), loaded)).toThrow(/unknown tool_call_id/);
    expect(() => validateScopeAtif(withScope([
      { ...plainAtif.steps[0], step_id: 2 },
      { ...plainAtif.steps[0], step_id: 1 },
    ]), loaded)).toThrow(/strictly increasing/);
  });
});
