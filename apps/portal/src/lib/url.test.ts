// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { encodeQsValue, qs, stripTrailingSlashes } from "./url";

describe("encodeQsValue", () => {
  it("passes through unreserved and cursor chars", () => {
    expect(encodeQsValue("createdAt~2025-01-15T10:00:00.000Z|id~abc123")).toBe(
      "createdAt~2025-01-15T10:00:00.000Z|id~abc123",
    );
  });

  it("encodes &", () => {
    expect(encodeQsValue("a&b")).toBe("a%26b");
  });

  it("encodes =", () => {
    expect(encodeQsValue("a=b")).toBe("a%3Db");
  });

  it("encodes #", () => {
    expect(encodeQsValue("a#b")).toBe("a%23b");
  });

  it("encodes +", () => {
    expect(encodeQsValue("a+b")).toBe("a%2Bb");
  });

  it("encodes spaces", () => {
    expect(encodeQsValue("a b")).toBe("a%20b");
  });

  it("encodes %", () => {
    expect(encodeQsValue("100%")).toBe("100%25");
  });
});

describe("qs", () => {
  it("returns empty string for no params", () => {
    expect(qs({})).toBe("");
  });

  it("skips undefined values", () => {
    expect(qs({ a: "1", b: undefined, c: "3" })).toBe("?a=1&c=3");
  });

  it("builds query string with cursor value", () => {
    expect(qs({ limit: "10", after: "createdAt~2025-01-15T10:00:00.000Z|id~abc" })).toBe(
      "?limit=10&after=createdAt~2025-01-15T10:00:00.000Z|id~abc",
    );
  });
});

describe("stripTrailingSlashes", () => {
  it("returns strings without a trailing slash unchanged", () => {
    expect(stripTrailingSlashes("https://docs.test")).toBe("https://docs.test");
  });

  it("strips one or many trailing slashes", () => {
    expect(stripTrailingSlashes("https://docs.test/")).toBe("https://docs.test");
    expect(stripTrailingSlashes("https://docs.test/v1////")).toBe("https://docs.test/v1");
  });

  it("returns an empty string for all-slashes and empty inputs", () => {
    expect(stripTrailingSlashes("///")).toBe("");
    expect(stripTrailingSlashes("")).toBe("");
  });

  it("keeps slashes that are not at the end", () => {
    expect(stripTrailingSlashes("//a//b//")).toBe("//a//b");
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
