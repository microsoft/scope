// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { computeTaskPromptId, TASK_PROMPT_NAMESPACE } from "./task-prompt-id.js";

describe("computeTaskPromptId", () => {
  it("returns a valid UUID string", () => {
    const id = computeTaskPromptId("Hello world");
    // UUIDv5 format: xxxxxxxx-xxxx-5xxx-yxxx-xxxxxxxxxxxx
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("is deterministic — same text always produces the same ID", () => {
    const a = computeTaskPromptId("Create a Hello World Express API");
    const b = computeTaskPromptId("Create a Hello World Express API");
    expect(a).toBe(b);
  });

  it("trims whitespace before hashing", () => {
    const a = computeTaskPromptId("  foo bar  ");
    const b = computeTaskPromptId("foo bar");
    expect(a).toBe(b);
  });

  it("produces different IDs for different texts", () => {
    const a = computeTaskPromptId("task one");
    const b = computeTaskPromptId("task two");
    expect(a).not.toBe(b);
  });

  it("handles empty string after trim", () => {
    const id = computeTaskPromptId("   ");
    // Should still produce a UUID (for the empty string)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("exposes TASK_PROMPT_NAMESPACE as a valid UUID", () => {
    expect(TASK_PROMPT_NAMESPACE).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
