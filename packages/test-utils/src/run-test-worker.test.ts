// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { parseTestResult, stripControlChars } from "./run-test-worker.js";

describe("stripControlChars", () => {
  it("removes Docker stream frame bytes but keeps newlines", () => {
    expect(stripControlChars("\x01\x00\x00\x00\x00\x00\x00\x05hello\nworld")).toBe("hello\nworld");
  });
});

describe("parseTestResult", () => {
  it("parses the TEST_RESULT line out of mixed container output", () => {
    const output = [
      "\x02\x00\x00\x00\x00\x00\x00\x10[12:00:00.000] test-worker starting",
      `\x01\x00\x00\x00\x00\x00\x00\x40TEST_RESULT:${JSON.stringify({ prompts: [{ success: true, response: "ok" }], lastStep: "Agent completed" })}`,
    ].join("\n");

    const result = parseTestResult(output);
    expect(result.prompts).toEqual([{ success: true, response: "ok" }]);
    expect(result.lastStep).toBe("Agent completed");
  });

  it("throws with a snippet of the output when no result is present", () => {
    expect(() => parseTestResult("container crashed")).toThrow(/No TEST_RESULT found in container output:\ncontainer crashed/);
  });
});
