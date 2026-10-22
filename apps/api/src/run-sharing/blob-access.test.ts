// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { scopedShareBlobName, parseSharedRange } from "./blob-access.js";
import { makeShare, makeRequest, blobUrl } from "./test-fixtures.js";

describe("shared artifact scope", () => {
  it("accepts only the pinned attempt's namespace", () => {
    const share = makeShare();
    const run = makeRequest().run!;
    expect(scopedShareBlobName(blobUrl("video.webm"), "snapshots", share, run)).toBe("request-1/runs/attempt-1/video.webm");
    expect(scopedShareBlobName(blobUrl("video.webm").replace("attempt-1", "attempt-2"), "snapshots", share, run)).toBeNull();
    expect(scopedShareBlobName(blobUrl("video.webm").replace("request-1", "request-2"), "snapshots", share, run)).toBeNull();
    expect(scopedShareBlobName(blobUrl("a%2F..%2Fsecret"), "snapshots", share, run)).toBeNull();
    expect(scopedShareBlobName("not-a-url", "snapshots", share, run)).toBeNull();
    expect(scopedShareBlobName(blobUrl("video.webm"), "logs", share, run)).toBeNull();
  });

  it("never falls back to a legacy request-wide namespace for a later attempt", () => {
    const share = makeShare();
    const run = makeRequest().run!;
    const legacy = "https://storage.example.test/snapshots/request-1/iteration-1/workspace.tar.gz";
    expect(scopedShareBlobName(legacy, "snapshots", share, run)).not.toBeNull();
    expect(scopedShareBlobName(legacy, "snapshots", share, { ...run, attemptNumber: 2 })).toBeNull();
  });
});

describe("shared byte ranges", () => {
  it.each([
    ["bytes=0-9", { start: 0, end: 9 }],
    ["bytes=90-", { start: 90, end: 99 }],
    ["bytes=-10", { start: 90, end: 99 }],
    ["bytes=0-1000", { start: 0, end: 99 }],
    ["bytes=-200", { start: 0, end: 99 }],
  ])("accepts %s", (header, range) => expect(parseSharedRange(header, 100)).toEqual(range));

  it.each(["bytes=100-", "bytes=20-10", "bytes=-0", "bytes=-", "bytes=0-1,4-5", "bytes=9007199254740992-", "something"])(
    "rejects %s", (header) => expect(parseSharedRange(header, 100)).toBeNull(),
  );
});
