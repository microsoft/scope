// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import type { AttemptProvenance } from "./assessment.js";
import { evaluate } from "./engine.js";
import type { PromptExecutionResult } from "./engine.js";
import { HandlerRegistry } from "./handlers.js";
import { parseScopeAtif } from "./scope-atif.js";
import { loadTaxonomy } from "./taxonomy.js";
import { createAtifProvenance } from "./atif/index.js";

async function neutralTaxonomy() {
  return loadTaxonomy(
    new URL("../fixtures/test-taxonomy.yaml", import.meta.url).pathname,
    { handlers: new HandlerRegistry() },
  );
}

function simpleAtif() {
  return parseScopeAtif({
    schema_version: "ATIF-v1.7",
    trajectory_id: "engine-test-document",
    session_id: "engine-test-run",
    agent: { name: "fixture", version: "1.0.0" },
    steps: [{ step_id: 1, source: "user", message: "Test." }],
  });
}

function promptSuccess(
  candidate: unknown,
  attempts: AttemptProvenance[] = [{
    attempt: 1,
    kind: "initial",
    outcome: "succeeded",
  }],
): PromptExecutionResult {
  return { status: "succeeded", candidate, attempts };
}

describe("generic taxonomy engine", () => {
  it("forwards cancellation and binds successful prompt output to exact input", async () => {
    const taxonomy = await neutralTaxonomy();
    const atif = simpleAtif();
    const controller = new AbortController();
    const executor = {
      evaluate: vi.fn(async (_element, _input, signal?: AbortSignal) => {
        expect(signal).toBe(controller.signal);
        return promptSuccess({ state: "completed", observed: false });
      }),
    };

    const [evaluation] = await evaluate(
      { atif, taxonomy },
      ["test-observation"],
      executor,
      controller.signal,
    );
    expect(evaluation).toMatchObject({
      status: "succeeded",
      result: { state: "completed", observed: false },
      input: {
        normalization: "scope/taxonome-normalized-atif/v1",
        trajectory_id: "engine-test-document",
        session_id: "engine-test-run",
      },
      implementation: {
        attempts: [{ attempt: 1, kind: "initial", outcome: "succeeded" }],
      },
    });
    expect(executor.evaluate).toHaveBeenCalledOnce();
  });

  it("preflights missing discovery, incomplete evidence, and missing task without model calls", async () => {
    const taxonomy = await neutralTaxonomy();
    const executor = { evaluate: vi.fn() };
    const complete = parseScopeAtif({
      schema_version: "ATIF-v1.7",
      session_id: "complete",
      agent: { name: "fixture", version: "1.0.0" },
      steps: [{ step_id: 1, source: "user", message: "Calculate." }],
      extra: {
        scope: {
          schema_version: "scope.atif-extension.v1",
          trajectory_state: "complete",
          task: "Calculate.",
          available_sources: [],
        },
      },
    });
    const [negative] = await evaluate(
      { atif: complete, taxonomy },
      ["discovery-required"],
      executor,
    );
    expect(negative).toMatchObject({
      status: "succeeded",
      result: { state: "completed", observed: false },
    });

    const partial = structuredClone(complete);
    partial.extra!.scope!.trajectory_state = "partial";
    const [incomplete] = await evaluate(
      { atif: partial, taxonomy },
      ["discovery-required"],
      executor,
    );
    expect(incomplete).toMatchObject({
      status: "succeeded",
      result: { state: "indeterminate" },
    });

    const missingTask = structuredClone(complete);
    delete missingTask.extra!.scope!.task;
    missingTask.steps = [{
      step_id: 1,
      source: "agent",
      message: "No task.",
    }];
    const [withoutTask] = await evaluate(
      { atif: missingTask, taxonomy },
      ["discovery-required"],
      executor,
    );
    expect(withoutTask).toMatchObject({
      status: "succeeded",
      result: { state: "indeterminate" },
    });
    expect(executor.evaluate).not.toHaveBeenCalled();
  });

  it("preserves precondition ordering and user-message task presence fallback", async () => {
    const taxonomy = await neutralTaxonomy();
    const partialMissingEverything = parseScopeAtif({
      schema_version: "ATIF-v1.7",
      session_id: "precondition-order",
      agent: { name: "fixture", version: "1.0.0" },
      steps: [{ step_id: 1, source: "agent", message: "No task." }],
      extra: {
        scope: {
          schema_version: "scope.atif-extension.v1",
          trajectory_state: "partial",
          available_sources: [],
        },
      },
    });
    const executor = { evaluate: vi.fn() };
    const [ordered] = await evaluate(
      { atif: partialMissingEverything, taxonomy },
      ["discovery-required"],
      executor,
    );
    expect(ordered).toMatchObject({
      status: "succeeded",
      result: {
        state: "indeterminate",
        reason: expect.stringContaining("complete trajectory evidence"),
      },
    });
    expect(executor.evaluate).not.toHaveBeenCalled();

    const userMessageTask = parseScopeAtif({
      schema_version: "ATIF-v1.7",
      session_id: "user-message-task",
      agent: { name: "fixture", version: "1.0.0" },
      steps: [{
        step_id: 1,
        source: "user",
        message: "Calculate the answer.",
        extra: {
          scope: {
            discoveries: [{
              source_id: "calculator",
              extension_point: "calculator",
            }],
          },
        },
      }],
      extra: {
        scope: {
          schema_version: "scope.atif-extension.v1",
          trajectory_state: "complete",
          available_sources: [{
            id: "calculator",
            label: "calculator",
            surface_id: "surface-mcp",
          }],
        },
      },
    });
    const promptExecutor = {
      evaluate: vi.fn(async () => promptSuccess({
        state: "completed",
        observed: false,
      })),
    };
    const [withFallbackTask] = await evaluate(
      { atif: userMessageTask, taxonomy },
      ["discovery-required"],
      promptExecutor,
    );
    expect(withFallbackTask.status).toBe("succeeded");
    expect(promptExecutor.evaluate).toHaveBeenCalledOnce();
  });

  it("uses Ax-observed correction provenance without an outer engine retry", async () => {
    const taxonomy = await neutralTaxonomy();
    const executor = {
      evaluate: vi.fn(async () => promptSuccess(
        { state: "completed", observed: false },
        [
          { attempt: 1, kind: "initial", outcome: "invalid_output" },
          { attempt: 2, kind: "repair", outcome: "succeeded" },
        ],
      )),
    };
    const [evaluation] = await evaluate(
      { atif: simpleAtif(), taxonomy },
      ["test-observation"],
      executor,
    );
    expect(evaluation).toMatchObject({
      status: "succeeded",
      implementation: {
        attempts: [
          { attempt: 1, kind: "initial", outcome: "invalid_output" },
          { attempt: 2, kind: "repair", outcome: "succeeded" },
        ],
      },
    });

    expect(executor.evaluate).toHaveBeenCalledOnce();
  });

  it("rejects a double-encoded prompt candidate at the parsed object boundary", async () => {
    const taxonomy = await neutralTaxonomy();
    const executor = {
      evaluate: vi.fn(async () => promptSuccess(
        JSON.stringify({ state: "completed", observed: false }),
      )),
    };
    const [evaluation] = await evaluate(
      { atif: simpleAtif(), taxonomy },
      ["test-observation"],
      executor,
    );

    expect(evaluation).toMatchObject({
      status: "failed",
      error: {
        code: "invalid_output",
        validation_errors: [{ code: "schema_mismatch" }],
      },
    });
    expect(executor.evaluate).toHaveBeenCalledOnce();
  });

  it("redacts credential-bearing prompt execution errors", async () => {
    const taxonomy = await neutralTaxonomy();
    const syntheticBearer = [
      "Authorization:",
      "Bearer",
      "synthetic-review-secret",
    ].join(" ");
    const secretExecutor = {
      evaluate: vi.fn(async () => {
        throw new Error(
          `${syntheticBearer} token=synthetic-token ` +
          "https://example.invalid/path?sig=signed",
        );
      }),
    };
    const [failure] = await evaluate(
      { atif: simpleAtif(), taxonomy },
      ["test-observation"],
      secretExecutor,
    );
    expect(failure.status).toBe("failed");
    if (failure.status !== "failed") return;
    expect(failure.error.message).toContain("Authorization=[redacted]");
    expect(failure.error.message).toContain("token=[redacted]");
    expect(failure.error.message).toContain("[redacted-url]");
    expect(failure.error.message).not.toContain("synthetic-review-secret");
    expect(failure.error.message).not.toContain("synthetic-token");
    expect(failure.error.message).not.toContain("signed");
    expect(secretExecutor.evaluate).toHaveBeenCalledOnce();
  });

  it("preserves Ax exhaustion diagnostics and attempt provenance", async () => {
    const taxonomy = await neutralTaxonomy();
    const executor = {
      evaluate: vi.fn(async (): Promise<PromptExecutionResult> => ({
        status: "failed",
        attempts: [
          { attempt: 1, kind: "initial", outcome: "invalid_output" },
          { attempt: 2, kind: "repair", outcome: "invalid_output" },
        ],
        error: {
          code: "invalid_output",
          message: "Ax output validation failed.",
          validation_errors: [{
            code: "unknown_role",
            output_path: "$.occurrences[0].evidence[0].role",
          }],
        },
      })),
    };
    const [evaluation] = await evaluate(
      { atif: simpleAtif(), taxonomy },
      ["test-observation"],
      executor,
    );
    expect(evaluation).toMatchObject({
      status: "failed",
      error: {
        code: "invalid_output",
      },
      implementation: {
        attempts: [
          { attempt: 1, kind: "initial", outcome: "invalid_output" },
          { attempt: 2, kind: "repair", outcome: "invalid_output" },
        ],
      },
    });
    expect(
      evaluation.status === "failed"
        ? evaluation.error.validation_errors?.map(value => value.code)
        : [],
    ).toContain("unknown_role");
    expect(executor.evaluate).toHaveBeenCalledOnce();
  });

  it("does not repair transport failures or invalid deterministic output", async () => {
    const taxonomy = await neutralTaxonomy();
    const executor = {
      evaluate: vi.fn(async () => {
        throw new Error("transport unavailable");
      }),
    };
    const [promptFailure] = await evaluate(
      { atif: simpleAtif(), taxonomy },
      ["test-observation"],
      executor,
    );
    expect(promptFailure).toMatchObject({
      status: "failed",
      error: { code: "execution_failed" },
      implementation: {
        attempts: [{
          attempt: 1,
          kind: "initial",
          outcome: "execution_failed",
        }],
      },
    });
    expect(executor.evaluate).toHaveBeenCalledOnce();

    const directory = await mkdtemp(join(tmpdir(), "taxonome-engine-invalid-"));
    try {
      const handlers = new HandlerRegistry();
      const handler = vi.fn(() => ({
        state: "completed",
        observed: true,
        occurrences: [{
          evidence: [{ role: "step", path: "$.steps[99]" }],
        }],
      }));
      handlers.register({
        "acme/invalid-v1": {
          configSchema: z.object({}).strict(),
          evaluate: handler,
        },
      }, { name: "invalid-test", origin: "local" });
      const path = join(directory, "taxonomy.yaml");
      await writeFile(path, `
schema_version: scope/taxonomy/v1
id: invalid-test
version: 1.0.0
surfaces: []
elements:
  - id: invalid
    label: Invalid
    implementation:
      type: deterministic
      handler: acme/invalid-v1
    preconditions: {}
    output:
      evidence_roles:
        step:
          type: atif.step
          description: Step.
`);
      const deterministic = await loadTaxonomy(path, { handlers });
      const [deterministicFailure] = await evaluate(
        {
          atif: simpleAtif(),
          atif_provenance: createAtifProvenance(
            { file: "wrapped.json" },
            "$[0]",
            "ATIF-v1.7",
          ),
          taxonomy: deterministic,
        },
        ["invalid"],
        executor,
      );
      expect(deterministicFailure).toMatchObject({
        status: "failed",
        error: {
          code: "invalid_output",
        },
      });
      expect(
        deterministicFailure.status === "failed"
          ? deterministicFailure.error.validation_errors?.map(value => value.code)
          : [],
      ).toContain("unresolved_reference");
      expect(
        deterministicFailure.status === "failed"
          ? deterministicFailure.error.source_locations
          : undefined,
      ).toEqual([{
        normalized_path: "$.steps[99]",
        original_path: "$[0].steps[99]",
        file: "wrapped.json",
      }]);
      expect(handler).toHaveBeenCalledOnce();
      expect(executor.evaluate).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("defaults plain ATIF to complete and rejects duplicate selections", async () => {
    const taxonomy = await neutralTaxonomy();
    const atif = simpleAtif();
    expect(atif.extra?.scope?.trajectory_state).toBe("complete");
    await expect(evaluate(
      { atif, taxonomy },
      ["test-observation", "test-observation"],
      {
        evaluate: async () =>
          promptSuccess({ state: "completed", observed: false }),
      },
    )).rejects.toThrow("unique element selection");
  });
});
