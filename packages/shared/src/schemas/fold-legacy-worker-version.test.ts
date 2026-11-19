// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { foldLegacyWorkerVersion } from "./request.js";

describe("foldLegacyWorkerVersion (#855)", () => {
  it("moves workerVersion into worker.version", () => {
    expect(foldLegacyWorkerVersion({ status: "done", workerVersion: "v1" }))
      .toEqual({ status: "done", worker: { version: "v1" } });
  });

  it("preserves existing worker identity fields", () => {
    expect(foldLegacyWorkerVersion({ workerVersion: "v1", worker: { instanceId: "i-1", podName: "p" } }))
      .toEqual({ worker: { instanceId: "i-1", podName: "p", version: "v1" } });
  });

  it("lets an existing worker.version win over the legacy field", () => {
    expect(foldLegacyWorkerVersion({ workerVersion: "old", worker: { instanceId: "i-1", version: "new" } }))
      .toEqual({ worker: { instanceId: "i-1", version: "new" } });
  });

  it("drops a non-string legacy value without inventing a worker", () => {
    expect(foldLegacyWorkerVersion({ status: "done", workerVersion: null })).toEqual({ status: "done" });
  });

  it("returns inputs without the legacy field unchanged", () => {
    const run = { status: "done", worker: { instanceId: "i-1" } };
    expect(foldLegacyWorkerVersion(run)).toBe(run);
    expect(foldLegacyWorkerVersion(undefined)).toBeUndefined();
    expect(foldLegacyWorkerVersion("x")).toBe("x");
  });
});
