// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { stripTrailingSlashes } from "./strings.js";

describe("stripTrailingSlashes", () => {
  it("returns strings without a trailing slash unchanged", () => {
    expect(stripTrailingSlashes("https://api.test")).toBe("https://api.test");
  });

  it("strips a single trailing slash", () => {
    expect(stripTrailingSlashes("https://api.test/")).toBe("https://api.test");
  });

  it("strips many trailing slashes", () => {
    expect(stripTrailingSlashes("https://api.test/v1////")).toBe("https://api.test/v1");
  });

  it("returns an empty string for an all-slashes input", () => {
    expect(stripTrailingSlashes("/")).toBe("");
    expect(stripTrailingSlashes("/////")).toBe("");
  });

  it("returns an empty string for an empty input", () => {
    expect(stripTrailingSlashes("")).toBe("");
  });

  it("keeps slashes that are not at the end", () => {
    expect(stripTrailingSlashes("a//b///c")).toBe("a//b///c");
    expect(stripTrailingSlashes("//a//b//")).toBe("//a//b");
  });

  it("does not strip other trailing characters", () => {
    expect(stripTrailingSlashes("https://api.test/ ")).toBe("https://api.test/ ");
    expect(stripTrailingSlashes("C:\\path\\")).toBe("C:\\path\\");
  });

  it.each([
    ["", ""],
    ["/", ""],
    ["a", "a"],
    ["a/", "a"],
    ["/a", "/a"],
    ["//a//", "//a"],
    ["a /", "a "],
    ["x/y//z///", "x/y//z"],
    ["https://host/path/?q=/", "https://host/path/?q="],
  ])("strips %j to %j", (input, expected) => {
    expect(stripTrailingSlashes(input)).toBe(expected);
  });

  it("handles a long pathological input in linear time", () => {
    const input = "/".repeat(100_000) + "x";
    const start = performance.now();
    expect(stripTrailingSlashes(input)).toBe(input);
    expect(stripTrailingSlashes(input + "/".repeat(100_000))).toBe(input);
    // The backtracking regex takes seconds on this input; the scan takes ~1ms.
    expect(performance.now() - start).toBeLessThan(500);
  });
});
