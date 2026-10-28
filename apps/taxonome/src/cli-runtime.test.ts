// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, vi } from "vitest";
import {
  createHandlerRegistry,
  loadTaxonomy,
  parseScopeAtif,
  type PromptExecutionResult,
  type PromptExecutor,
} from "taxonomy-engine";
import { createLazyPromptExecutor } from "./cli.js";

describe("Taxonome lazy prompt runtime wrapper", () => {
  it("forwards AbortSignal through the exact lazy executor layer", async () => {
    const taxonomy = await loadTaxonomy(
      new URL(
        "../../../packages/taxonomy-engine/fixtures/test-taxonomy.yaml",
        import.meta.url,
      ).pathname,
      { handlers: createHandlerRegistry() },
    );
    const element = taxonomy.elementById.get("test-observation")!;
    const input = {
      taxonomy,
      atif: parseScopeAtif({
        schema_version: "ATIF-v1.7",
        session_id: "lazy-signal",
        agent: { name: "fixture", version: "1.0.0" },
        steps: [{ step_id: 1, source: "user", message: "Test." }],
      }),
    };
    const controller = new AbortController();
    const underlying: PromptExecutor = {
      evaluate: vi.fn(async (_element, _input, signal) => {
        expect(signal).toBe(controller.signal);
        return {
          status: "succeeded",
          candidate: { state: "completed", observed: false },
          attempts: [{
            attempt: 1,
            kind: "initial",
            outcome: "succeeded",
          }],
        } satisfies PromptExecutionResult;
      }),
    };
    const start = vi.fn(async () => underlying);
    const lazy = createLazyPromptExecutor(start);

    await lazy.evaluate(element, input, controller.signal);
    await lazy.evaluate(element, input, controller.signal);
    expect(start).toHaveBeenCalledOnce();
    expect(underlying.evaluate).toHaveBeenCalledTimes(2);
  });
});
