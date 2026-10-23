// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { mintRunToken } from "shared";
import { forwardableRunToken } from "./run-token-forwarding.js";

describe("forwardableRunToken", () => {
  it("forwards a well-formed run token", () => {
    const { token } = mintRunToken("req-1");
    expect(forwardableRunToken(`Bearer ${token}`)).toBe(token);
    expect(forwardableRunToken(`bearer ${token}`)).toBe(token);
  });

  it("does not forward missing, malformed, or non-run credentials", () => {
    expect(forwardableRunToken(undefined)).toBeUndefined();
    expect(forwardableRunToken("")).toBeUndefined();
    expect(forwardableRunToken("Bearer eyJhbGciOi.user.jwt")).toBeUndefined();
    expect(forwardableRunToken("Basic abc")).toBeUndefined();
    expect(forwardableRunToken("Bearer scope_rt_req-1_tampered")).toBeUndefined();
  });
});
