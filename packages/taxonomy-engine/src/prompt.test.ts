// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, vi } from "vitest";
import { createHandlerRegistry } from "./handlers.js";
import {
  createTaxonomyPromptProgram,
  TAXONOMY_AX_OUTPUT_CONTRACT,
  YAML_OBSERVATION_CONTRACT,
} from "./prompt.js";
import { loadTaxonomy } from "./taxonomy.js";

describe("Taxonome Ax output contract", () => {
  it("uses one parsed JSON observation field without claiming native enforcement", async () => {
    const taxonomy = await loadTaxonomy(
      new URL("../fixtures/test-taxonomy.yaml", import.meta.url).pathname,
      { handlers: createHandlerRegistry() },
    );
    const onOptimizationCandidate = vi.fn();
    const program = createTaxonomyPromptProgram(
      taxonomy.elementById.get("test-observation")!,
      { onOptimizationCandidate },
    );
    const signature = program.getSignature().toJSON();

    expect(TAXONOMY_AX_OUTPUT_CONTRACT).toEqual({
      signature: "trajectory_context:string -> observation:json",
      wire_field: "observation",
      wire_parser: "ax-json",
      native_structured_outputs: false,
      runtime_validation: "taxonome-validateAssessment-assertion",
      runtime_correction_retries: 1,
      optimizer_correction_retries: 0,
      optimizer_invalid_output: "score-zero",
    });
    expect(signature.inputFields.map(field => field.name)).toEqual([
      "trajectory_context",
    ]);
    expect(signature.outputFields).toMatchObject([{
      name: "observation",
      type: { name: "json", isArray: false },
      isOptional: false,
    }]);
    expect(signature.description).toContain("Shared assessment schema:");
    expect(signature.description).toContain('"required":["evidence"]');
    expect(signature.description).not.toContain('"required":["Evidence"]');
    expect(signature.description).toContain(
      "Assessment JSON property-name casing is significant.",
    );
    expect(program.getOptimizableComponents()).toEqual([
      expect.objectContaining({
        key: "test-observation@prompt::instruction",
        kind: "instruction",
        description:
          taxonomy.elementById.get("test-observation")!.description ??
          taxonomy.elementById.get("test-observation")!.label,
        current: taxonomy.elementById.get("test-observation")!.implementation
          .type === "prompt"
          ? taxonomy.elementById.get("test-observation")!.implementation.prompt
          : "",
      }),
    ]);
    expect(program.getOptimizableComponents()[0]?.current).not.toContain(
      "Shared assessment schema",
    );
    expect(program.getOptimizableComponents()[0]?.validate?.(
      taxonomy.elementById.get("test-observation")!.implementation.type ===
        "prompt"
        ? taxonomy.elementById.get("test-observation")!.implementation.prompt
        : "",
    )).toBe("Propose a materially different instruction for evaluation.");
    expect(program.getOptimizableComponents()[0]?.validate?.(
      "A materially different instruction.",
    )).toBe(true);
    expect(onOptimizationCandidate.mock.calls).toEqual([
      [{ changed: false }],
      [{ changed: true }],
    ]);
    expect(YAML_OBSERVATION_CONTRACT).not.toContain("repair_context");
  });
});
