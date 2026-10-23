// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import {
  RUN_TOKEN_PREFIX,
  hashRunToken,
  isRunToken,
  mintRunToken,
  parseRunToken,
  runTokenHashPrefix,
  runTokenHashesEqual,
} from "./run-token.js";

const REQUEST_ID = "6f1c2f1e-1d2b-4c3a-9e8f-0a1b2c3d4e5f";

describe("run-token", () => {
  it("mints an opaque prefixed token whose hash is persisted, not the token", () => {
    const { token, hash } = mintRunToken(REQUEST_ID);
    expect(token.startsWith(`${RUN_TOKEN_PREFIX}${REQUEST_ID}_`)).toBe(true);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashRunToken(token));
    expect(hash).not.toContain(token);
  });

  it("mints unique tokens per call", () => {
    const a = mintRunToken(REQUEST_ID);
    const b = mintRunToken(REQUEST_ID);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).not.toBe(b.hash);
  });

  it("parses the request id from a well-formed token", () => {
    const { token } = mintRunToken(REQUEST_ID);
    expect(isRunToken(token)).toBe(true);
    expect(parseRunToken(token)).toEqual({ requestId: REQUEST_ID });
  });

  it("rejects tokens with a bad checksum, truncation, or wrong prefix", () => {
    const { token } = mintRunToken(REQUEST_ID);
    const flipped = token.slice(0, -10) + (token.at(-10) === "A" ? "B" : "A") + token.slice(-9);
    expect(parseRunToken(flipped)).toBeNull();
    expect(parseRunToken(token.slice(0, -1))).toBeNull();
    expect(parseRunToken(token.replace(RUN_TOKEN_PREFIX, "scope_xx_"))).toBeNull();
    expect(parseRunToken("scope_rt_")).toBeNull();
    expect(parseRunToken("eyJhbGciOi.jwt.value")).toBeNull();
  });

  it("refuses to mint for an unsafe request id", () => {
    expect(() => mintRunToken("bad id/../")).toThrow();
    expect(() => mintRunToken("")).toThrow();
  });

  it("compares digests in constant time and rejects malformed digests", () => {
    const { token, hash } = mintRunToken(REQUEST_ID);
    expect(runTokenHashesEqual(hash, hashRunToken(token))).toBe(true);
    expect(runTokenHashesEqual(hash, mintRunToken(REQUEST_ID).hash)).toBe(false);
    expect(runTokenHashesEqual(hash, "short")).toBe(false);
    expect(runTokenHashesEqual("z".repeat(64), hash)).toBe(false);
  });

  it("exposes only an 8-char digest prefix for logs", () => {
    const { hash } = mintRunToken(REQUEST_ID);
    expect(runTokenHashPrefix(hash)).toBe(hash.slice(0, 8));
  });
});
