// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getPromptTarget } from "../adapter/registry.js";
import type {
  AdapterContext,
  ComposedPromptRequest,
  QualityCaseRow,
} from "../adapter/protocol.js";
import { validateDataset } from "./validate-dataset.js";

const DATASET_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../datasets",
);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function fakeResponse(row: QualityCaseRow, request: ComposedPromptRequest): string {
  const input = record(row.input);
  switch (row.family) {
    case "criteria-authoring":
      return '{"prompt":"Inspect the available evidence and decide whether the behavior is satisfied.","suggestedId":"generated_criterion"}';
    case "parent-dependency-suggestion":
    case "child-dependency-suggestion":
      return '{"suggestions":[]}';
    case "task-prompt-generation":
    case "task-prompt-variation":
      return '{"taskPrompt":"Build a small, tested application that satisfies the requested behavior."}';
    case "prompt-feature-authoring":
      return '{"prompt":"Detect whether the task requests this behavior.","suggestedId":"asks_for_behavior","suggestedParents":[],"suggestedChildren":[]}';
    case "prompt-feature-extraction":
      return JSON.stringify({
        results: (Array.isArray(input.features) ? input.features : []).map((feature) => ({
          featureId: record(feature).id,
          detected: false,
        })),
        suggestedFeatures: [],
      });
    case "judge-instructions": {
      if (row.variant === "independent") return "PASS:\nThe supplied evidence supports the criterion.";
      return JSON.stringify({
        results: (Array.isArray(input.criteria) ? input.criteria : []).map((criterion) => ({
          criterion: record(criterion).id,
          passed: true,
          feedback: "The supplied evidence supports the criterion.",
        })),
      });
    }
    case "developer-feedback":
      return "Implement the missing requirement and rerun the relevant check.";
    case "run-report":
      expect(request.tools?.length).toBeGreaterThan(0);
      return "# Run report\n\nThe run evidence was reviewed.";
  }
}

describe("curated dataset adapter contract", () => {
  it("parses every committed case with its production adapter", async () => {
    const { cases } = await validateDataset(DATASET_ROOT);
    const context: AdapterContext = {
      model: "fake-model",
      async complete(request) {
        const row = currentRow;
        return { content: fakeResponse(row, request), metadata: { transport: "fake" } };
      },
    };
    let currentRow: QualityCaseRow = cases[0];

    for (const row of cases) {
      currentRow = row;
      const result = await getPromptTarget(row.family, row.variant).run(
        row.input,
        row.variant,
        context,
      );
      expect(result.request.metadata.adapterId).toContain(row.family);
    }
  });

  it("keeps every manifest file valid JSONL", async () => {
    const manifest = JSON.parse(
      await readFile(resolve(DATASET_ROOT, "manifest.json"), "utf8"),
    ) as { files: Array<{ path: string; rows: number }> };
    for (const entry of manifest.files) {
      const lines = (await readFile(resolve(DATASET_ROOT, entry.path), "utf8"))
        .split(/\r?\n/)
        .filter(Boolean);
      expect(lines).toHaveLength(entry.rows);
      expect(lines.every((line) => Boolean(JSON.parse(line) as unknown))).toBe(true);
    }
  });
});
