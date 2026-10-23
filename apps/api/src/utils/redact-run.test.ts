// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { redactRunSecrets, redactRunState } from "./redact-run.js";

describe("redact-run", () => {
  it("removes tokenHash from a run", () => {
    const run = { _id: "r1", status: "processing" as const, tokenHash: "a".repeat(64) };
    expect(redactRunState(run)).toEqual({ _id: "r1", status: "processing" });
    expect(run.tokenHash).toBeDefined();
  });

  it("removes tokenHash from an embedded run without mutating the source", () => {
    const doc = { _id: "q1", run: { _id: "r1", tokenHash: "b".repeat(64) } };
    const redacted = redactRunSecrets(doc);
    expect(redacted.run).toEqual({ _id: "r1" });
    expect(doc.run.tokenHash).toBeDefined();
  });

  it("returns documents without secrets unchanged", () => {
    const doc = { _id: "q1", run: { _id: "r1" } };
    expect(redactRunSecrets(doc)).toBe(doc);
    const noRun = { _id: "q2" };
    expect(redactRunSecrets(noRun)).toBe(noRun);
  });
});
