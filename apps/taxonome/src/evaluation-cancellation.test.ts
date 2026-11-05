// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { installEvaluationCancellation } from "./evaluation-cancellation.js";

describe("evaluation SIGINT cancellation", () => {
  it("aborts once and removes the signal handler", () => {
    const emitter = new EventEmitter();
    const controller = new AbortController();
    const interrupted = vi.fn();
    const dispose = installEvaluationCancellation(
      controller,
      interrupted,
      emitter,
    );

    emitter.emit("SIGINT");
    expect(controller.signal.aborted).toBe(true);
    expect(interrupted).toHaveBeenCalledOnce();
    dispose();
    expect(emitter.listenerCount("SIGINT")).toBe(0);
  });
});
