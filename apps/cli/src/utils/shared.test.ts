// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, describe, it, expect, vi } from "vitest";
import { getDefaultApiUrl, normalizeUrl } from "./shared.js";

afterEach(() => vi.unstubAllEnvs());

describe("getDefaultApiUrl", () => {
  it("reads the explicitly configured URL", () => {
    vi.stubEnv("SCOPE_API_URL", " https://api.example.com ");
    expect(getDefaultApiUrl()).toBe("https://api.example.com");
  });

  it.each([undefined, "", "  "])("has no fallback when SCOPE_API_URL is %j", (url) => {
    vi.stubEnv("SCOPE_API_URL", url);
    vi.stubEnv("SCOPE_DEFAULT_API_URL", "https://legacy.example.com");
    vi.stubEnv("SCOPE_API_PORT", "5108");
    expect(getDefaultApiUrl()).toBeUndefined();
  });
});

describe("normalizeUrl", () => {
  it.each([undefined, "", "  "])("rejects missing URL %j with configuration guidance", (url) => {
    expect(() => normalizeUrl(url)).toThrow("No API URL configured. Set SCOPE_API_URL or pass -u/--url");
  });

  it("trims whitespace and trailing slashes from an explicit URL", () => {
    expect(normalizeUrl(" https://api.example.com/// ")).toBe("https://api.example.com");
  });
});
