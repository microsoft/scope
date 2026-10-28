// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { parseScopeAtif } from "../scope-atif.js";
import {
  hasTaskContext,
  requiresTask,
} from "./requires-task.js";

function atif(options: {
  scopeTask?: string;
  source?: "user" | "agent";
  message?: string | ReadonlyArray<
    | { type: "text"; text: string }
    | { type: "image"; source: { media_type: "image/png"; path: string } }
  >;
} = {}) {
  return parseScopeAtif({
    schema_version: "ATIF-v1.7",
    agent: { name: "fixture", version: "1.0.0" },
    steps: [{
      step_id: 1,
      source: options.source ?? "agent",
      message: typeof options.message === "string" ||
          options.message === undefined
        ? options.message ?? "No task context."
        : [...options.message],
    }],
    extra: {
      scope: {
        schema_version: "scope.atif-extension.v1",
        trajectory_state: "complete",
        ...(options.scopeTask ? { task: options.scopeTask } : {}),
        available_sources: [],
      },
    },
  });
}

describe("requires_task precondition", () => {
  it.each([
    ["Scope task", { scopeTask: "Do the task." }, true],
    ["user text", { source: "user", message: "Do the task." }, true],
    [
      "mixed-content user text",
      {
        source: "user",
        message: [
          { type: "image", source: { media_type: "image/png", path: "a.png" } },
          { type: "text", text: "Do the task." },
        ],
      },
      true,
    ],
    ["empty user text", { source: "user", message: "   " }, false],
    [
      "media-only user message",
      {
        source: "user",
        message: [{
          type: "image",
          source: { media_type: "image/png", path: "a.png" },
        }],
      },
      false,
    ],
    ["agent text", { source: "agent", message: "Not user task context." }, false],
  ] as const)("%s", (_label, options, expected) => {
    expect(hasTaskContext(atif(options))).toBe(expected);
  });

  it("is bypassed when disabled and indeterminate when enabled without context", () => {
    const input = atif();
    expect(requiresTask(false, input, "Element")).toBeUndefined();
    expect(requiresTask(true, input, "Element")).toMatchObject({
      state: "indeterminate",
      reason: expect.stringContaining("requires task evidence"),
    });
  });
});
