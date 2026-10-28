// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { CreateRunShareSchema, UpdateRunShareSchema, FULL_SHARE_CONTENT, SUMMARY_SHARE_CONTENT } from "./run-share.js";

describe("run share policies", () => {
  it("defaults to Summary without detailed data", () => {
    expect(CreateRunShareSchema.parse({}).content).toEqual(SUMMARY_SHARE_CONTENT);
    expect(Object.values(SUMMARY_SHARE_CONTENT)).not.toContain(true);
  });

  it("keeps sensitive artifact types off in the Full preset", () => {
    expect(FULL_SHARE_CONTENT).toMatchObject({ snapshots: false, network: false, video: false });
    expect(CreateRunShareSchema.safeParse({ content: FULL_SHARE_CONTENT }).success).toBe(false);
    expect(CreateRunShareSchema.safeParse({ content: FULL_SHARE_CONTENT, acknowledgeSensitiveContent: true }).success).toBe(true);
  });

  it.each(Object.keys(SUMMARY_SHARE_CONTENT))("requires explicit acknowledgment for %s", (category) => {
    const content = { ...SUMMARY_SHARE_CONTENT, [category]: true };
    expect(CreateRunShareSchema.safeParse({ content }).success).toBe(false);
    expect(UpdateRunShareSchema.safeParse({ content }).success).toBe(false);
    expect(UpdateRunShareSchema.safeParse({ content, acknowledgeSensitiveContent: true }).success).toBe(true);
  });

  it("rejects unknown policy fields and empty updates", () => {
    expect(CreateRunShareSchema.safeParse({ content: { ...SUMMARY_SHARE_CONTENT, secrets: true } }).success).toBe(false);
    expect(CreateRunShareSchema.safeParse({ public: true }).success).toBe(false);
    expect(UpdateRunShareSchema.safeParse({}).success).toBe(false);
    expect(UpdateRunShareSchema.safeParse({ acknowledgeSensitiveContent: true }).success).toBe(false);
  });

  it("allows independently changing or removing expiry", () => {
    expect(UpdateRunShareSchema.parse({ expiresAt: null })).toEqual({ expiresAt: null });
    expect(UpdateRunShareSchema.safeParse({ expiresAt: "not-a-date" }).success).toBe(false);
  });
});
