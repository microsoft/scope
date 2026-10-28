// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { parseScopeAtif } from "../scope-atif.js";
import {
  evaluatePreconditions,
  type PreconditionsElement,
} from "./evaluate.js";

function element(
  preconditions: PreconditionsElement["preconditions"],
  implementation: "prompt" | "deterministic" = "prompt",
): PreconditionsElement {
  return {
    label: "Element",
    implementation: { type: implementation },
    preconditions,
  };
}

function atif(options: {
  state?: "complete" | "partial" | "unknown";
  task?: boolean;
  discovery?: boolean;
} = {}) {
  return parseScopeAtif({
    schema_version: "ATIF-v1.7",
    agent: { name: "fixture", version: "1.0.0" },
    steps: [{
      step_id: 1,
      source: options.task ? "user" : "agent",
      message: options.task ? "Do the task." : "No task.",
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

const allEnabled = {
  requires_complete_trajectory: true,
  requires_task: true,
  requires_recorded_discovery: true,
};

describe("ordered precondition evaluation", () => {
  it("orders completeness before task and discovery", () => {
    expect(evaluatePreconditions(
      atif({ state: "partial" }),
      element(allEnabled),
    )).toMatchObject({
      state: "indeterminate",
      reason: expect.stringContaining("complete trajectory"),
    });
  });

  it("orders task before discovery", () => {
    expect(evaluatePreconditions(
      atif({ state: "complete" }),
      element(allEnabled),
    )).toMatchObject({
      state: "indeterminate",
      reason: expect.stringContaining("task evidence"),
    });
  });

  it("applies discovery only after completeness and task pass", () => {
    expect(evaluatePreconditions(
      atif({ state: "complete", task: true }),
      element(allEnabled),
    )).toEqual({ state: "completed", observed: false });
  });

  it("returns no preflight result when all enabled requirements pass", () => {
    expect(evaluatePreconditions(
      atif({ state: "complete", task: true, discovery: true }),
      element(allEnabled),
    )).toBeUndefined();
  });

  it("normal disabled defaults do not block evaluation", () => {
    expect(evaluatePreconditions(
      atif({ state: "partial" }),
      element({
        requires_complete_trajectory: false,
        requires_task: false,
        requires_recorded_discovery: false,
      }),
    )).toBeUndefined();
  });
});
