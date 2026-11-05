// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildReadoutV2,
  loadReadoutCollection,
  loadReadoutInputs,
  readoutMarkdownV2,
  resolveReadoutFiles,
} from "./readout-v2.js";
import { createHandlerRegistry } from "./handlers.js";
import { createInputIdentity } from "./input-identity.js";
import { parseScopeAtif } from "./scope-atif.js";
import { loadTaxonomy } from "./taxonomy.js";
import {
  AtifIngestionError,
  createAtifProvenance,
} from "./atif/index.js";

const conformance = fileURLToPath(new URL(
  "../conformance/trajectory-taxonomy-format/",
  import.meta.url,
));
const runContext = {
  scenario: { id: "scenario", label: "Scenario" },
  profile: { id: "profile", label: "Profile" },
};

async function fixtures() {
  const taxonomy = await loadTaxonomy(`${conformance}valid/taxonomy.yaml`, {
    handlers: createHandlerRegistry(),
  });
  const atif = parseScopeAtif(JSON.parse(await readFile(
    `${conformance}valid/atif-v17.json`,
    "utf8",
  )) as unknown);
  return { taxonomy, atif };
}

function evaluation(
  taxonomy: Awaited<ReturnType<typeof loadTaxonomy>>,
  atif: ReturnType<typeof parseScopeAtif>,
  result: unknown,
) {
  const element = taxonomy.elementById.get("malformed")!;
  return {
    schema_version: "scope/taxonomy-evaluation/v1" as const,
    taxonomy: {
      id: taxonomy.id,
      version: taxonomy.version,
      digest: taxonomy.digest,
    },
    element: { id: element.id, label: element.label },
    implementation: {
      type: "prompt" as const,
      attempts: [{
        attempt: 1 as const,
        kind: "initial" as const,
        outcome: "succeeded" as const,
      }],
    },
    input: createInputIdentity(atif),
    status: "succeeded" as const,
    result,
  };
}

const occurrence = {
  evidence: [
    { role: "call", path: "$.steps[1].tool_calls[0]" },
    {
      role: "issue",
      path:
        "$.steps[1].tool_calls[0].extra.scope.input_validation.issues[0]",
    },
  ],
};

describe("v2 readout", () => {
  it("counts occurrences separately from references and resolves source attribution", async () => {
    const { taxonomy, atif } = await fixtures();
    const report = buildReadoutV2([
      {
        run: { id: "one", ...runContext },
        results: [evaluation(taxonomy, atif, {
          state: "completed",
          observed: true,
          occurrences: [occurrence, occurrence],
        })],
      },
      {
        run: { id: "two", ...runContext },
        results: [evaluation(taxonomy, atif, {
          state: "completed",
          observed: true,
          occurrences: [occurrence],
        })],
      },
      {
        run: { id: "three", ...runContext },
        results: [],
      },
    ], taxonomy, [{ atif, source: "fixture" }]);

    const behavior = report.groups[0].behaviors.find(item =>
      item.element_id === "malformed"
    )!;
    expect(behavior).toMatchObject({
      coverage: {
        total: 3,
        assessed: 2,
        unknown: 1,
        missing: 1,
      },
      distinct_runs: 2,
      occurrences: 3,
      sources: [{
        source: {
          id: "account",
          label: "account/query",
          surface_id: "surface-mcp",
        },
        distinct_runs: 2,
        occurrences: 3,
      }],
    });
    expect(readoutMarkdownV2(report))
      .toContain("$.steps[1].tool_calls[0]");
  });

  it("distinguishes negative, unavailable, inapplicable, failed, and missing coverage", async () => {
    const { taxonomy, atif } = await fixtures();
    const base = evaluation(taxonomy, atif, {
      state: "completed",
      observed: false,
    });
    const failed = {
      ...base,
      status: "failed" as const,
      result: undefined,
      error: {
        code: "execution_failed" as const,
        message: "provider unavailable",
      },
      implementation: {
        ...base.implementation,
        attempts: [{
          attempt: 1 as const,
          kind: "initial" as const,
          outcome: "execution_failed" as const,
        }],
      },
    };
    delete (failed as { result?: unknown }).result;
    const report = buildReadoutV2([
      { run: { id: "negative", ...runContext }, results: [base] },
      {
        run: { id: "unknown", ...runContext },
        results: [evaluation(taxonomy, atif, {
          state: "indeterminate",
          reason: "Unknown.",
        })],
      },
      {
        run: { id: "inapplicable", ...runContext },
        results: [evaluation(taxonomy, atif, {
          state: "inapplicable",
          reason: "Not applicable.",
        })],
      },
      { run: { id: "failed", ...runContext }, results: [failed] },
      { run: { id: "missing", ...runContext }, results: [] },
    ], taxonomy, [{ atif, source: "fixture" }]);
    const behavior = report.groups[0].behaviors.find(item =>
      item.element_id === "malformed"
    )!;
    expect(behavior.coverage).toMatchObject({
      total: 5,
      assessed: 1,
      negative: 1,
      unknown: 2,
      inapplicable: 1,
      error: 1,
      missing: 1,
    });
  });

  it("rejects duplicate runs, digest mismatches, missing inputs, and invalid evidence", async () => {
    const { taxonomy, atif } = await fixtures();
    const run = {
      run: { id: "one", ...runContext },
      results: [evaluation(taxonomy, atif, {
        state: "completed",
        observed: false,
      })],
    };
    expect(() => buildReadoutV2(
      [run, run],
      taxonomy,
      [{ atif, source: "fixture" }],
    )).toThrow("Duplicate readout run");
    expect(() => buildReadoutV2(
      [{
        ...run,
        results: [{
          ...run.results[0],
          taxonomy: {
            ...run.results[0].taxonomy,
            digest: "0".repeat(64),
          },
        }],
      }],
      taxonomy,
      [{ atif, source: "fixture" }],
    )).toThrow("does not match");
    expect(() => buildReadoutV2([run], taxonomy, []))
      .toThrow("no matching --inputs");
    const changedAtif = structuredClone(atif);
    changedAtif.steps[0].message = "Changed after the evaluation was created.";
    expect(() => buildReadoutV2(
      [run],
      taxonomy,
      [{
        atif: changedAtif,
        source: "forged-fixture",
        identity: createInputIdentity(atif),
      }],
    )).toThrow("supplied identity metadata");
    expect(() => buildReadoutV2([{
      ...run,
      results: [{
        ...run.results[0],
        input: {
          ...run.results[0].input,
          trajectory_id: "different-document",
        },
      }],
    }], taxonomy, [{ atif, source: "fixture" }]))
      .toThrow("trajectory_id");
    try {
      buildReadoutV2([{
        ...run,
        results: [evaluation(taxonomy, atif, {
          state: "completed",
          observed: true,
          occurrences: [{
            evidence: [
              { role: "call", path: "$.steps[0]" },
              occurrence.evidence[1],
            ],
          }],
        })],
      }], taxonomy, [{
        atif,
        atif_provenance: createAtifProvenance(
          { file: "wrapped.json" },
          "$[0]",
          "ATIF-v1.7",
        ),
        source: "fixture",
      }]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AtifIngestionError);
      expect((error as AtifIngestionError).diagnostic).toMatchObject({
        code: "atif_readout_evidence_mismatch",
        stage: "result_validation",
        file: "wrapped.json",
        original_path: "$[0].steps[0]",
        normalized_path: "$.steps[0]",
      });
    }
  });

  it("disambiguates equal normalized inputs by verified selected-file origin", async () => {
        const { taxonomy, atif } = await fixtures();
        const firstOrigin = {
          selected_input: "/inputs/one/trajectory.json",
        };
        const secondOrigin = {
          selected_input: "/inputs/two/trajectory.json",
        };
        const makeRun = (id: string, origin: typeof firstOrigin) => ({
          run: { id, ...runContext },
          results: [evaluation(taxonomy, atif, {
            state: "completed",
            observed: false,
          })],
          metadata: {
            source: { input_origin: origin },
          },
        });
        const inputs = [
          {
            atif,
            source: "one",
            origin: firstOrigin,
          },
          {
            atif: structuredClone(atif),
            source: "two",
            origin: secondOrigin,
          },
        ];

        expect(buildReadoutV2([
          makeRun("run-one--source-a", firstOrigin),
          makeRun("run-two--source-b", secondOrigin),
        ], taxonomy, inputs)).toMatchObject({
          failed_runs: [],
          groups: [{
            behaviors: expect.arrayContaining([
              expect.objectContaining({
                element_id: "malformed",
                coverage: expect.objectContaining({ total: 2 }),
              }),
            ]),
          }],
        });

        expect(() => buildReadoutV2([{
          run: { id: "legacy", ...runContext },
          results: [evaluation(taxonomy, atif, {
            state: "completed",
            observed: false,
          })],
        }], taxonomy, inputs)).toThrow("ambiguous across source origins");
  });

  it.each([
    "$.steps[*]",
    '$["steps"',
  ])("retains invalid result path diagnostics without source-map parsing: %s", async path => {
    const { taxonomy, atif } = await fixtures();
    const run = {
      run: { id: "invalid-path", ...runContext },
      results: [evaluation(taxonomy, atif, {
        state: "completed",
        observed: true,
        occurrences: [{
          evidence: [
            { role: "call", path },
            occurrence.evidence[1],
          ],
        }],
      })],
    };

    try {
      buildReadoutV2([run], taxonomy, [{
        atif,
        atif_provenance: createAtifProvenance(
          { file: "wrapped.json" },
          "$[0]",
          "ATIF-v1.7",
        ),
        source: "fixture",
      }]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AtifIngestionError);
      expect((error as AtifIngestionError).diagnostic).toMatchObject({
        code: "atif_readout_evidence_mismatch",
        stage: "result_validation",
        file: "wrapped.json",
        original_path: "$[0]",
        normalized_path: path,
      });
      expect((error as Error).message).toContain("invalid_jsonpath");
      expect((error as Error).message).toContain(path);
    }
  });

  it("accepts metadata and reports explicit failed run records in partial output", async () => {
    const { taxonomy, atif } = await fixtures();
    const report = buildReadoutV2([
      {
        run: { id: "one", ...runContext },
        results: [evaluation(taxonomy, atif, {
          state: "completed",
          observed: false,
        })],
        metadata: { source: { archive_root: "request-one" } },
      },
      {
        schema_version: "scope/taxonome-run-error/v1",
        root: "request-two",
        request_id: "request-two",
        stage: "parse",
        error: "missing evidence",
      },
    ], taxonomy, [{ atif, source: "fixture" }]);
    expect(report.groups).toHaveLength(1);
    expect(report.failed_runs).toEqual([
      expect.objectContaining({ root: "request-two", stage: "parse" }),
    ]);
    expect(readoutMarkdownV2(report)).toContain("## Failed runs");
  });

  it("requires exact parse-root identity for invalid evidence coverage", async () => {
    const { taxonomy } = await fixtures();
    const invalidInput = {
      kind: "invalid" as const,
      source: "new-archive",
      root: "new-root",
      requestId: "same-request",
      runId: "new-attempt",
      error: "new parse failure",
    };
    const error = (
      root: string,
      requestId: string,
      runId: string,
      stage: "parse" | "evaluation" = "parse",
    ) => ({
      schema_version: "scope/taxonome-run-error/v1",
      root,
      request_id: requestId,
      run_id: runId,
      stage,
      error: "persisted failure",
    });

    expect(() => buildReadoutV2(
      [error("other-root", "same-request", "old-attempt")],
      taxonomy,
      [invalidInput],
    )).toThrow("no matching persisted Taxonome error record");
    expect(() => buildReadoutV2(
      [error("new-root", "same-request", "old-attempt")],
      taxonomy,
      [invalidInput],
    )).toThrow("no matching persisted Taxonome error record");
    expect(() => buildReadoutV2(
      [error("new-root", "same-request", "new-attempt", "evaluation")],
      taxonomy,
      [invalidInput],
    )).toThrow("no matching persisted Taxonome error record");

    const report = buildReadoutV2(
      [error("new-root", "same-request", "new-attempt")],
      taxonomy,
      [invalidInput],
    );
    expect(report.failed_runs).toEqual([
      expect.objectContaining({
        root: "new-root",
        request_id: "same-request",
        run_id: "new-attempt",
        stage: "parse",
      }),
    ]);
  });

  it("retains explicit unavailable evidence paths for persisted error matching", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taxonome-readout-missing-"));
    const missing = join(directory, "missing.atif.json");
    try {
      const { taxonomy } = await fixtures();
      await expect(loadReadoutInputs(
        [missing],
        taxonomy,
      )).resolves.toMatchObject([{
        kind: "invalid",
        source: `${missing}#input`,
        root: "input",
        origin: { selected_input: missing },
      }]);
    } finally {
      await (await import("node:fs/promises"))
        .rm(directory, { recursive: true, force: true });
    }
  });

  it("resolves result files, directories, and globs with stable overlap deduplication", async () => {
    const { taxonomy, atif } = await fixtures();
    const directory = await mkdtemp(join(tmpdir(), "taxonome-readout-"));
    const nested = join(directory, "results");
    await mkdir(nested);
    const successPath = join(nested, "a.json");
    const errorPath = join(nested, "b.json");
    const ignoredPath = join(nested, "ignored.json");
    const success = {
      run: { id: "one", ...runContext },
      results: [evaluation(taxonomy, atif, {
        state: "completed",
        observed: false,
      })],
    };
    await writeFile(successPath, JSON.stringify(success));
    await writeFile(errorPath, JSON.stringify({
      schema_version: "scope/taxonome-run-error/v1",
      root: "request-two",
      stage: "evaluation",
      error: "failed",
    }));
    await writeFile(ignoredPath, JSON.stringify({ unrelated: true }));

    const files = await resolveReadoutFiles([
      nested,
      join(nested, "*.json"),
      successPath,
    ]);
    expect(files).toEqual([successPath, errorPath, ignoredPath].sort());
    const values = await loadReadoutCollection([nested, successPath]);
    expect(values).toHaveLength(2);
    expect(() => buildReadoutV2(
      values,
      taxonomy,
      [{ atif, source: "fixture" }],
    )).not.toThrow();
    await expect(resolveReadoutFiles([join(directory, "missing-*.json")]))
      .rejects.toThrow("matched no recognized files");
  });

  it("fails closed on recognizable stale results and malformed JSON in directories", async () => {
    const { taxonomy, atif } = await fixtures();
    const directory = await mkdtemp(join(tmpdir(), "taxonome-readout-stale-"));
    const current = {
      run: { id: "current", ...runContext },
      results: [evaluation(taxonomy, atif, {
        state: "completed",
        observed: false,
      })],
    };
    const currentPath = join(directory, "current.json");
    const stalePath = join(directory, "stale.json");
    await writeFile(currentPath, JSON.stringify(current));
    await writeFile(stalePath, JSON.stringify({
      run: { id: "stale", ...runContext },
      results: [{
        schema_version: "scope/taxonomy-evaluation/v1",
        taxonomy: current.results[0].taxonomy,
        element: current.results[0].element,
        implementation: { type: "prompt" },
        result: { state: "completed", observed: false },
      }],
    }));
    await expect(resolveReadoutFiles([directory])).rejects.toThrow(
      /stale\.json.*stale or invalid.*--force/,
    );

    await writeFile(stalePath, "{broken");
    await expect(resolveReadoutFiles([directory])).rejects.toThrow(
      /stale\.json.*malformed JSON/,
    );
  });
});
