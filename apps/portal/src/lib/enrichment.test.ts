// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { deriveEnrichmentStatus } from "./enrichment";
import type { RunState } from "@/types";

function makeRun(partial: Partial<RunState>): RunState {
  return { _id: "r1", attemptNumber: 1, status: "done", ...partial } as RunState;
}

describe("deriveEnrichmentStatus", () => {
  it("returns undefined when there is no run", () => {
    expect(deriveEnrichmentStatus(undefined, false)).toBeUndefined();
  });

  it("falls back to the legacy scalar for runs without a handler DAG", () => {
    expect(deriveEnrichmentStatus(makeRun({ postProcessorStatus: "done" }), false)).toBe("done");
    expect(deriveEnrichmentStatus(makeRun({ postProcessorStatus: "processing" }), true)).toBe("processing");
    expect(deriveEnrichmentStatus(makeRun({ handlerStatus: {} }), false)).toBeUndefined();
  });

  it("stays processing while pp-atif is still running", () => {
    const run = makeRun({ handlerStatus: { "pp-atif": { status: "processing" } } });
    expect(deriveEnrichmentStatus(run, false)).toBe("processing");
  });

  it("reports done once the only handler (pp-atif) is done and no observations are configured", () => {
    const run = makeRun({
      postProcessorStatus: "done",
      handlerStatus: { "pp-atif": { status: "done" } },
    });
    expect(deriveEnrichmentStatus(run, false)).toBe("done");
  });

  it("does NOT flip to done after pp-atif while pp-observations is still pending (the bug)", () => {
    // Observations configured, pp-atif done, pp-observations not yet dispatched.
    const beforeDispatch = makeRun({
      postProcessorStatus: "done", // legacy scalar already flipped — must be ignored
      handlerStatus: { "pp-atif": { status: "done" } },
    });
    expect(deriveEnrichmentStatus(beforeDispatch, true)).toBe("processing");

    // pp-observations queued.
    const queued = makeRun({
      postProcessorStatus: "done",
      handlerStatus: { "pp-atif": { status: "done" }, "pp-observations": { status: "queued" } },
    });
    expect(deriveEnrichmentStatus(queued, true)).toBe("processing");

    // pp-observations processing.
    const processing = makeRun({
      postProcessorStatus: "done",
      handlerStatus: { "pp-atif": { status: "done" }, "pp-observations": { status: "processing" } },
    });
    expect(deriveEnrichmentStatus(processing, true)).toBe("processing");
  });

  it("flips to done only once both pp-atif and pp-observations are done", () => {
    const run = makeRun({
      handlerStatus: { "pp-atif": { status: "done" }, "pp-observations": { status: "done" } },
    });
    expect(deriveEnrichmentStatus(run, true)).toBe("done");
  });

  it("reports failed when a handler failed and nothing is still in flight", () => {
    const run = makeRun({
      handlerStatus: { "pp-atif": { status: "done" }, "pp-observations": { status: "failed" } },
    });
    expect(deriveEnrichmentStatus(run, true)).toBe("failed");
  });

  it("prefers processing over failed while another handler is still running", () => {
    const run = makeRun({
      handlerStatus: { "pp-atif": { status: "processing" }, "pp-observations": { status: "failed" } },
    });
    expect(deriveEnrichmentStatus(run, true)).toBe("processing");
  });

  it("treats a no-op pp-observations (no observations) as part of the DAG", () => {
    // No observations configured, but pp-observations still runs as a no-op handler.
    const stillRunning = makeRun({
      handlerStatus: { "pp-atif": { status: "done" }, "pp-observations": { status: "processing" } },
    });
    expect(deriveEnrichmentStatus(stillRunning, false)).toBe("processing");

    const allDone = makeRun({
      handlerStatus: { "pp-atif": { status: "done" }, "pp-observations": { status: "done" } },
    });
    expect(deriveEnrichmentStatus(allDone, false)).toBe("done");
  });
});
