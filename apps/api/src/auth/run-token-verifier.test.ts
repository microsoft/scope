// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, vi } from "vitest";
import { AuthError, mintRunToken } from "shared";
import {
  DEFAULT_RUN_TOKEN_MAX_AGE_MS,
  createRunTokenVerifier,
  resolveRunTokenMaxAgeMs,
} from "./run-token-verifier.js";

const NOW = Date.parse("2026-01-01T12:00:00Z");
const HOUR = 60 * 60 * 1000;

function setup(overrides: { run?: Record<string, unknown>; doc?: Record<string, unknown> | null } = {}) {
  const { token, hash } = mintRunToken("req-1");
  const doc =
    overrides.doc === null
      ? null
      : {
          _id: "req-1",
          projectId: "project-1",
          run: {
            _id: "run-1",
            status: "processing",
            tokenHash: hash,
            startedAt: new Date(NOW - HOUR),
            ...overrides.run,
          },
          ...overrides.doc,
        };
  const findOne = vi.fn().mockResolvedValue(doc);
  const verify = createRunTokenVerifier(() => ({ findOne }) as never, {
    maxAgeMs: 2 * HOUR,
    now: () => NOW,
  });
  return { token, hash, findOne, verify };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(AuthError);
  return (err as AuthError).code;
}

describe("createRunTokenVerifier", () => {
  it("accepts a token whose digest matches the processing run's claim", async () => {
    const { token, hash, findOne, verify } = setup();
    await expect(verify(token)).resolves.toEqual({
      requestId: "req-1",
      runId: "run-1",
      projectId: "project-1",
      tokenHash: hash,
    });
    // Point read by request id with a projection that never returns the full doc.
    expect(findOne).toHaveBeenCalledWith(
      { _id: "req-1" },
      expect.objectContaining({ projection: expect.objectContaining({ "run.tokenHash": 1 }) }),
    );
  });

  it("rejects malformed tokens without a database read", async () => {
    const { findOne, verify } = setup();
    expect(await codeOf(verify("scope_rt_garbage"))).toBe("invalid_run_token");
    expect(findOne).not.toHaveBeenCalled();
  });

  it("rejects a forged token for a real run", async () => {
    const { verify } = setup();
    const forged = mintRunToken("req-1").token;
    expect(await codeOf(verify(forged))).toBe("invalid_run_token");
  });

  it.each([
    ["missing request", { doc: null }],
    ["deleted request", { doc: { deletedAt: new Date(NOW) } }],
    ["no stored digest", { run: { tokenHash: undefined } }],
  ])("rejects %s as invalid", async (_label, overrides) => {
    const { token, verify } = setup(overrides as never);
    expect(await codeOf(verify(token))).toBe("invalid_run_token");
  });

  it.each(["queued", "done", "pending"])("rejects a run in status %s", async (status) => {
    const { token, verify } = setup({ run: { status } });
    expect(await codeOf(verify(token))).toBe("run_not_active");
  });

  it("rejects a claim older than the absolute max age", async () => {
    const { token, verify } = setup({ run: { startedAt: new Date(NOW - 3 * HOUR) } });
    expect(await codeOf(verify(token))).toBe("run_token_expired");
  });

  it("rejects a claim without a start time", async () => {
    const { token, verify } = setup({ run: { startedAt: undefined } });
    expect(await codeOf(verify(token))).toBe("run_token_expired");
  });

  it("fails as service_unavailable when the database is unavailable", async () => {
    const { token } = setup();
    const noCollection = createRunTokenVerifier(() => undefined);
    expect(await codeOf(noCollection(token))).toBe("service_unavailable");

    const findOne = vi.fn().mockRejectedValue(new Error("boom"));
    const failing = createRunTokenVerifier(() => ({ findOne }) as never);
    expect(await codeOf(failing(token))).toBe("service_unavailable");
  });
});

describe("resolveRunTokenMaxAgeMs", () => {
  it("parses positive values and falls back otherwise", () => {
    expect(resolveRunTokenMaxAgeMs("1000")).toBe(1000);
    expect(resolveRunTokenMaxAgeMs(undefined)).toBe(DEFAULT_RUN_TOKEN_MAX_AGE_MS);
    expect(resolveRunTokenMaxAgeMs("0")).toBe(DEFAULT_RUN_TOKEN_MAX_AGE_MS);
    expect(resolveRunTokenMaxAgeMs("nope")).toBe(DEFAULT_RUN_TOKEN_MAX_AGE_MS);
  });
});
