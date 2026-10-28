// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertObservation,
  checkEvaluationInput,
  loadEvaluationData,
  loadEvaluationInputs,
  loadGroundTruth,
  resolveEvaluationFiles,
  type EvaluationInput,
  type GroundTruth,
} from "./evaluation-inputs.js";
import type { Evaluation } from "./engine.js";
import { createHandlerRegistry } from "./handlers.js";
import { loadTaxonomy } from "./taxonomy.js";
import { createAtifProvenance } from "./atif/index.js";
import { parseScopeAtif } from "./scope-atif.js";

async function neutralTaxonomy() {
  return loadTaxonomy(
    new URL("../fixtures/test-taxonomy.yaml", import.meta.url).pathname,
    { handlers: createHandlerRegistry() },
  );
}

const atif = (sessionId: string) => ({
  schema_version: "ATIF-v1.7",
  session_id: sessionId,
  agent: { name: "fixture", version: "1.0.0" },
  steps: [{ step_id: 1, source: "user", message: "Test." }],
});

const input = (
  id: string,
  split = "test",
  family = `family-${id}`,
  originatingRun = `origin-${id}`,
) => ({
  id,
  family,
  originating_run: originatingRun,
  split,
  provenance: "neutral engine fixture",
  elements: ["test-observation"],
  atif: atif(`session-${id}`),
});

describe("generic evaluation inputs and ground truth", () => {
  it("counts missing, duplicate, and unexpected evaluation envelopes", async () => {
    const taxonomy = await neutralTaxonomy();
    const row: EvaluationInput = {
      ...input("input-01"),
      split: "test",
      source_file: "inputs.jsonl",
      source_line: 1,
      atif_provenance: createAtifProvenance(
        { file: "inputs.jsonl", jsonl_line: 1 },
        "$.atif",
        "ATIF-v1.7",
      ),
      atif: parseScopeAtif({
        ...atif("session-01"),
        extra: {
          scope: {
            schema_version: "scope.atif-extension.v1",
            trajectory_state: "complete",
            available_sources: [],
          },
        },
      }),
    };
    const groundTruth: GroundTruth = {
      "input-01": {
        "test-observation": {
          state: "completed",
          observed: false,
        },
      },
    };
    const evaluation: Evaluation = {
      schema_version: "scope/taxonomy-evaluation/v1",
      taxonomy: {
        id: taxonomy.id,
        version: taxonomy.version,
        digest: taxonomy.digest,
      },
      element: { id: "test-observation", label: "Test Observation" },
      implementation: {
        type: "prompt",
        attempts: [{ attempt: 1, kind: "initial", outcome: "succeeded" }],
      },
      input: {
        normalization: "scope/taxonome-normalized-atif/v1",
        sha256: "a".repeat(64),
      },
      status: "succeeded",
      result: { state: "completed", observed: false },
    };

    expect(checkEvaluationInput(row, [], groundTruth)).toEqual([
      "Expected exactly one result for test-observation, got 0",
    ]);
    expect(checkEvaluationInput(row, [evaluation], groundTruth)).toEqual([]);
    expect(checkEvaluationInput(row, [evaluation, evaluation], groundTruth))
      .toContain("Expected exactly one result for test-observation, got 2");
  });

  it("requires reviewed occurrence grouping and role-qualified references", () => {
    expect(assertObservation({
      state: "completed",
      observed: true,
      occurrences: [{
        evidence: [{ role: "call", path: "$.steps[1].tool_calls[0]" }],
      }],
    }, {
      state: "completed",
      observed: true,
      occurrences: [{
        evidence: [{ role: "call", path: "$.steps[1].tool_calls[1]" }],
      }],
    })).toEqual([
      "Positive occurrence grouping/references do not match reviewed ground truth",
    ]);
  });

  it("sorts and deduplicates overlapping input/ground-truth globs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taxonomy-inputs-"));
    try {
      await writeFile(
        join(directory, "b-inputs.jsonl"),
        `${JSON.stringify(input("b"))}\n`,
      );
      await writeFile(
        join(directory, "a-inputs.jsonl"),
        `${JSON.stringify(input("a"))}\n`,
      );
      await writeFile(
        join(directory, "a-ground-truth.json"),
        JSON.stringify({
          a: { "test-observation": { state: "completed", observed: false } },
        }),
      );
      await writeFile(
        join(directory, "b-ground-truth.json"),
        JSON.stringify({
          b: { "test-observation": { state: "completed", observed: false } },
        }),
      );

      const files = await resolveEvaluationFiles(
        ["*-inputs.jsonl", "a-inputs.jsonl"],
        directory,
        "input",
      );
      expect(files.map(file => file.split("/").at(-1))).toEqual([
        "a-inputs.jsonl",
        "b-inputs.jsonl",
      ]);
      const data = await loadEvaluationData(
        ["*-inputs.jsonl", "a-inputs.jsonl"],
        ["*-ground-truth.json"],
        await neutralTaxonomy(),
        directory,
      );
      expect(data.inputs.map(row => row.id)).toEqual(["a", "b"]);
      expect(data.inputs.map(row => row.source_file)).toEqual([
        "a-inputs.jsonl",
        "b-inputs.jsonl",
      ]);
      expect(data.inputs[0].atif_provenance).toMatchObject({
        source: { file: "a-inputs.jsonl", jsonl_line: 1 },
        container_prefix: "$.atif",
        source_version: "ATIF-v1.7",
      });
      expect(data.ground_truth.files).toEqual([
        "a-ground-truth.json",
        "b-ground-truth.json",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails unmatched patterns, duplicate IDs/pairs, and missing ground truth", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taxonomy-conflicts-"));
    try {
      const taxonomy = await neutralTaxonomy();
      await expect(loadEvaluationInputs(
        ["missing-*.jsonl"],
        taxonomy,
        directory,
      )).rejects.toThrow("input pattern 'missing-*.jsonl' matched no files");

      await writeFile(
        join(directory, "unit-inputs.jsonl"),
        `${JSON.stringify({ ...input("unit-input"), split: "unit" })}\n`,
      );
      await expect(loadEvaluationInputs(
        ["unit-inputs.jsonl"],
        taxonomy,
        directory,
      )).rejects.toThrow();
      await rm(join(directory, "unit-inputs.jsonl"));

      await writeFile(
        join(directory, "one-inputs.jsonl"),
        `${JSON.stringify(input("duplicate"))}\n`,
      );
      await writeFile(
        join(directory, "two-inputs.jsonl"),
        `${JSON.stringify(input("duplicate"))}\n`,
      );
      await expect(loadEvaluationInputs(
        ["*-inputs.jsonl"],
        taxonomy,
        directory,
      )).rejects.toThrow("Duplicate input ID 'duplicate'");

      await writeFile(
        join(directory, "one-ground-truth.json"),
        JSON.stringify({
          duplicate: {
            "test-observation": { state: "completed", observed: false },
          },
        }),
      );
      await writeFile(
        join(directory, "two-ground-truth.json"),
        JSON.stringify({
          duplicate: {
            "test-observation": { state: "completed", observed: false },
          },
        }),
      );
      await expect(loadGroundTruth(
        ["*-ground-truth.json"],
        directory,
      )).rejects.toThrow(
        "Duplicate ground-truth pair 'duplicate/test-observation'",
      );

      await rm(join(directory, "two-inputs.jsonl"));
      await rm(join(directory, "one-ground-truth.json"));
      await rm(join(directory, "two-ground-truth.json"));
      await writeFile(join(directory, "empty-ground-truth.json"), "{}");
      await expect(loadEvaluationData(
        ["*-inputs.jsonl"],
        ["empty-ground-truth.json"],
        taxonomy,
        directory,
      )).rejects.toThrow(
        "Missing ground truth for 'duplicate/test-observation' declared at one-inputs.jsonl:1",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects family and originating-run leakage between splits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taxonomy-inputs-"));
    await writeFile(join(directory, "inputs.jsonl"), [
      input("train", "train", "shared", "origin-a"),
      input("test", "test", "shared", "origin-b"),
    ].map(value => JSON.stringify(value)).join("\n"));
    try {
      await expect(loadEvaluationInputs(
        ["inputs.jsonl"],
        await neutralTaxonomy(),
        directory,
      )).rejects.toThrow("leakage");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("locates JSONL Scope semantic failures at the original line and field", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taxonome-eval-source-"));
    try {
      const file = join(directory, "inputs.jsonl");
      const base = input("invalid-surface");
      const invalid = {
        ...base,
        atif: {
          ...base.atif,
          extra: {
            scope: {
              schema_version: "scope.atif-extension.v1",
              available_sources: [{
                id: "source",
                label: "Source",
                surface_id: "undeclared",
              }],
            },
          },
        },
      };
      await writeFile(file, `\n${JSON.stringify(invalid)}\n`);

      await expect(loadEvaluationInputs(
        [file],
        await neutralTaxonomy(),
        directory,
      )).rejects.toMatchObject({
        diagnostic: {
          code: "atif_unknown_scope_surface",
          file: "inputs.jsonl",
          jsonl_line: 2,
          original_path:
            "$.atif.extra.scope.available_sources[0].surface_id",
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
