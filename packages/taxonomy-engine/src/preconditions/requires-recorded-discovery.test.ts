// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { parseScopeAtif } from "../scope-atif.js";
import {
  hasRecordedDiscovery,
  requiresRecordedDiscovery,
} from "./requires-recorded-discovery.js";

function atif(options: {
  state?: "complete" | "partial" | "unknown";
  discovery?: boolean;
} = {}) {
  return parseScopeAtif({
    schema_version: "ATIF-v1.7",
    agent: { name: "fixture", version: "1.0.0" },
    steps: [{
      step_id: 1,
      source: "agent",
      message: "Evidence.",
      ...(options.discovery
        ? {
          extra: {
            scope: {
              discoveries: [{
                source_id: "source",
                extension_point: "query",
              }],
            },
          },
        }
        : {}),
    }],
    extra: {
      scope: {
        schema_version: "scope.atif-extension.v1",
        trajectory_state: options.state ?? "complete",
        available_sources: options.discovery
          ? [{ id: "source", label: "query", surface_id: "surface" }]
          : [],
      },
    },
  });
}

describe("requires_recorded_discovery precondition", () => {
  it("detects only recorded discovery events", () => {
    expect(hasRecordedDiscovery(atif({ discovery: true }))).toBe(true);
    expect(hasRecordedDiscovery(atif())).toBe(false);
  });

  it.each([
    ["disabled", false, "prompt", "complete", false, undefined],
    ["deterministic exempt", true, "deterministic", "complete", false, undefined],
    ["partial exempt", true, "prompt", "partial", false, undefined],
    ["unknown exempt", true, "prompt", "unknown", false, undefined],
    ["recorded discovery", true, "prompt", "complete", true, undefined],
    ["complete prompt without discovery", true, "prompt", "complete", false, false],
  ] as const)(
    "%s",
    (_label, enabled, implementation, state, discovery, observed) => {
      const result = requiresRecordedDiscovery(
        enabled,
        implementation,
        atif({ state, discovery }),
      );
      if (observed === undefined) {
        expect(result).toBeUndefined();
      } else {
        expect(result).toEqual({ state: "completed", observed });
      }
    },
  );
});
