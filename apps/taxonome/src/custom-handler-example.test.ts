// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import {
  assessmentSchema,
  type DeterministicHandlerInput,
  HandlerRegistry,
  loadTaxonomy,
  validateAssessment,
} from "taxonomy-engine";
import {
  loadEvaluationInputs,
  loadGroundTruth,
} from "taxonomy-engine/evaluation-inputs";
import { taxonomyPromptEvidence } from "../../../packages/taxonomy-engine/src/prompt.js";
import {
  retryHandler,
} from "../../../examples/taxonome-custom-handler/src/handlers/index.js";

describe("custom retry handler output contract", () => {
  it("keeps the TypeScript producer schema consistent with element YAML", async () => {
    const handlers = new HandlerRegistry();
    handlers.register({ "acme/retry-loop-v1": retryHandler }, {
      name: "taxonome-custom-handler-example",
      version: "1.0.0",
      origin: "local",
    });
    const taxonomy = await loadTaxonomy(
      new URL(
        "../../../examples/taxonome-custom-handler/taxonomy.yaml",
        import.meta.url,
      ).pathname,
      { handlers },
    );
    const element = taxonomy.elementById.get("acme-retry-loop");
    expect(element).toBeDefined();

    const sample = {
      state: "completed",
      observed: false,
    } as const;
    expect(assessmentSchema.parse(sample)).toEqual(sample);
  });

  it("does not turn unattributed positive retry evidence into a negative", async () => {
    const handlers = new HandlerRegistry();
    handlers.register({ "acme/retry-loop-v1": retryHandler }, {
      name: "taxonome-custom-handler-example",
      version: "1.0.0",
      origin: "local",
    });
    const taxonomy = await loadTaxonomy(
      new URL(
        "../../../examples/taxonome-custom-handler/taxonomy.yaml",
        import.meta.url,
      ).pathname,
      { handlers },
    );
    const element = taxonomy.elementById.get("acme-retry-loop")!;
    const input: DeterministicHandlerInput = {
      taxonomy: {
        schema_version: "scope/taxonomy/v1",
        id: "fixture",
        version: "1.0.0",
        digest: "fixture",
        surfaces: [],
      },
      atif: {
        schema_version: "ATIF-v1.8",
        session_id: "unattributed-retry",
        agent: { name: "fixture", version: "1.0.0" },
        steps: [{
          step_id: 1,
          source: "agent",
          message: "Retry completed.",
          tool_calls: [{
            tool_call_id: "retry-1",
            function_name: "query",
            arguments: {},
            extra: {
              scope: {
                response: { recovered: true, attempts: 3 },
              },
            },
          }],
        }],
        extra: {
          scope: {
            schema_version: "scope.atif-extension.v1",
            trajectory_state: "complete",
            available_sources: [],
          },
        },
      },
    };

    const result = retryHandler.evaluate(input, { min_attempts: 2 });
    expect(result).toEqual({
      state: "completed",
      observed: true,
      occurrences: [{
        evidence: [{
          role: "call",
          path: "$.steps[0].tool_calls[0]",
        }],
      }],
    });
    expect(validateAssessment(result, element.output, input.atif).diagnostics)
      .toEqual([]);
  });

  it("keeps model-visible identities opaque in the production prompt projection", async () => {
    const handlers = new HandlerRegistry();
    handlers.register({ "acme/retry-loop-v1": retryHandler }, {
      name: "taxonome-custom-handler-example",
      version: "1.0.0",
      origin: "local",
    });
    const root = new URL(
      "../../../examples/taxonome-custom-handler/",
      import.meta.url,
    );
    const taxonomy = await loadTaxonomy(
      new URL("taxonomy.yaml", root).pathname,
      { handlers },
    );
    const inputs = await loadEvaluationInputs(
      [new URL(
        "datasets/repeated-request/trajectory-inputs.jsonl",
        root,
      ).pathname],
      taxonomy,
    );
    const groundTruth = await loadGroundTruth([
      new URL(
        "datasets/repeated-request/ground-truth.json",
        root,
      ).pathname,
    ]);

    expect(taxonomy.elementById.get("acme-repeated-request")?.implementation)
      .toMatchObject({ type: "prompt" });
    expect(inputs.map(input => input.split)).toEqual([
      "train",
      "train",
      "validation",
      "validation",
      "test",
      "test",
    ]);
    expect(new Set(inputs.map(input => input.family)).size).toBe(inputs.length);
    expect(new Set(inputs.map(input => input.originating_run)).size)
      .toBe(inputs.length);
    expect(Object.keys(groundTruth.values)).toEqual(
      inputs.map(input => input.id),
    );

    for (const input of inputs) {
      const projected = JSON.parse(taxonomyPromptEvidence({
        atif: input.atif,
        taxonomy,
      })) as {
        atif: typeof input.atif;
      };
      const serialized = JSON.stringify(projected);
      expect(serialized).not.toContain(input.id);
      expect(serialized).not.toContain(input.family);
      expect(serialized).not.toContain(input.originating_run);

      const run = projected.atif.extra?.scope?.run;
      const identities = [
        projected.atif.session_id,
        run?.id,
        run?.scenario_id,
        run?.profile_id,
      ];
      for (const identity of identities) {
        expect(identity).toMatch(/^(session|run|scenario|profile)-[a-f0-9]{4}$/);
        expect(identity).not.toMatch(
          /repeat|choice|format|confirm|path|detail|positive|negative/i,
        );
      }
      expect(run?.scenario_label).toMatch(/^Scenario [A-F0-9]{4}$/);
      expect(run?.profile_label).toMatch(/^Profile [A-F0-9]{4}$/);
    }
  });
});
