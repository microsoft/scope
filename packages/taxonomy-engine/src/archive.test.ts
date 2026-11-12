// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { gzipSync } from "node:zlib";
import { Readable } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pack } from "tar-stream";
import { stringify as yamlStringify } from "yaml";
import { describe, expect, it } from "vitest";
import { createHandlerRegistry } from "./handlers.js";
import {
  normalizeScopeArchive,
  normalizeScopeArchiveRoots,
  loadAtifInputResult,
  loadAtifInputs,
  scanScopeArchive,
} from "./archive.js";
import { loadTaxonomy } from "./taxonomy.js";
import { originalAtifPath } from "./atif/index.js";
import { createInputIdentity } from "./input-identity.js";

/** Builds one gzip/tar buffer from explicit test entries. */
async function archive(entries: Array<{
  name: string;
  body?: string;
  type?: "file" | "symlink" | "directory" | "character-device";
  linkname?: string;
}>): Promise<Buffer> {
  const tar = pack();
  const chunks: Buffer[] = [];
  tar.on("data", chunk => chunks.push(Buffer.from(chunk)));
  const finished = new Promise<void>((resolve, reject) => {
    tar.on("end", resolve);
    tar.on("error", reject);
  });
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? "");
    tar.entry({
      name: entry.name,
      type: entry.type ?? "file",
      linkname: entry.linkname,
      size: entry.type === "file" || !entry.type ? body.length : 0,
    }, body);
  }
  tar.finalize();
  await finished;
  return gzipSync(Buffer.concat(chunks));
}

/** Creates exporter-shaped run.yaml with shared RunState-required turn fields. */
function runYaml(
  status: "processing" | "paused" | "done" = "done",
  iterations = [1, 2],
  options: {
    mcpRegistered?: boolean;
    resourceSetupSucceeded?: boolean;
  } = {},
) {
  return yamlStringify({
    _id: "request-1",
    workerType: "fixture-worker",
    scenario: {
      _id: "scenario-1",
      name: "Archive scenario",
      task: "Query the account service.",
    },
    profileId: "profile-1",
    mcpServers: ["account/query"],
    resources: [{
      slug: "account-docs",
      ref: "resource/account-docs",
    }],
    run: {
      _id: "run-1",
      attemptNumber: 1,
      status,
      ...(status === "done"
        ? { finishedAt: "2026-01-01T00:01:00.000Z", outcome: "succeeded" }
        : {}),
      ...(options.mcpRegistered !== undefined
        ? { mcpRegistered: options.mcpRegistered }
        : {}),
      ...(options.resourceSetupSucceeded !== undefined
        ? {
          resources: [{
            ref: "resource/account-docs",
            slug: "account-docs",
            revisionId: "resource-revision-1",
            setupSucceeded: options.resourceSetupSucceeded,
            published: [],
          }],
        }
        : {}),
      turns: iterations.map(iteration => ({
        iteration,
        judgeFeedback: "",
        snapshotUrl: `https://example.invalid/${iteration}.tar.gz`,
        passed: true,
        timestamp: "2026-01-01T00:00:00.000Z",
        atifUrl: `iteration-${iteration}.atif.trajectory.json`,
      })),
    },
  });
}

/** Creates a trajectory with no source/discovery/call availability claims. */
function emptyIterationAtif(
  state: "complete" | "partial" | "unknown" = "complete",
) {
  return JSON.stringify({
    schema_version: "ATIF-v1.7",
    session_id: "empty-iteration",
    agent: { name: "fixture", version: "1.0.0" },
    steps: [{
      step_id: 1,
      source: "agent",
      message: "No source evidence.",
    }],
    extra: {
      scope: {
        schema_version: "scope.atif-extension.v1",
        trajectory_state: state,
        available_sources: [],
      },
    },
  });
}

/** Creates one per-iteration ATIF with colliding step/call IDs. */
function iterationAtif(iteration: number) {
  return JSON.stringify({
    schema_version: "ATIF-v1.7",
    session_id: `iteration-${iteration}`,
    agent: { name: "fixture", version: "1.0.0" },
    steps: [{
      step_id: 1,
      source: "agent",
      message: `Iteration ${iteration}`,
      tool_calls: [{
        tool_call_id: "duplicate-call",
        function_name: "account/query",
        arguments: {},
        extra: {
          scope: {
            source_id: "account/query",
            outcome: iteration === 2 ? "timeout" : "completed",
            duration_ms: iteration === 2 ? 30000 : 10,
            ...(iteration === 1
              ? {
                input_validation: {
                  status: "invalid",
                  issues: [{ code: "missing_field", path: "$.accountId" }],
                },
              }
              : {}),
          },
        },
      }],
      observation: {
        results: [{ source_call_id: "duplicate-call", content: "result" }],
      },
      ...(iteration === 1
        ? {
          extra: {
            scope: {
              discoveries: [{
                source_id: "account/query",
                extension_point: "account/query",
              }],
            },
          },
        }
        : {}),
    }],
    extra: {
      scope: {
        schema_version: "scope.atif-extension.v1",
        trajectory_state: "complete",
        available_sources: [{
          id: "account/query",
          label: "account/query",
          surface_id: "surface-mcp",
        }],
      },
    },
  });
}

/** Creates one ATIF-v1.8 iteration with message and observation audio parts. */
function iterationAtifV18(iteration: number) {
  return JSON.stringify({
    schema_version: "ATIF-v1.8",
    session_id: `iteration-${iteration}`,
    trajectory_id: `trajectory-${iteration}`,
    agent: { name: "fixture", version: "2.0.0" },
    steps: [{
      step_id: 1,
      source: "agent",
      message: [
        { type: "text", text: `Iteration ${iteration}` },
        {
          type: "audio",
          source: {
            media_type: "audio/mp3",
            path: `audio/message-${iteration}.mp3`,
          },
        },
      ],
      tool_calls: [{
        tool_call_id: "audio-call",
        function_name: "audio/query",
        arguments: {},
      }],
      observation: {
        results: [{
          source_call_id: "audio-call",
          content: [{
            type: "audio",
            source: {
              media_type: "audio/x-wav",
              path: `audio/result-${iteration}.wav`,
              duration_sec: 2,
            },
          }],
        }],
      },
    }],
  });
}

async function taxonomy() {
  return loadTaxonomy(
    new URL("../fixtures/test-taxonomy.yaml", import.meta.url).pathname,
    { handlers: createHandlerRegistry() },
  );
}

describe("Scope run archive normalization", () => {
  it("distinguishes plain input from an archive root literally named input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taxonome-input-kind-"));
    const plainPath = join(directory, "plain.json");
    const archivePath = join(directory, "archive.json");
    try {
      await writeFile(plainPath, emptyIterationAtif());
      await writeFile(archivePath, await archive([
        { name: "input/run.yaml", body: runYaml("done", [1]) },
        {
          name: "input/iteration-1.atif.trajectory.json",
          body: emptyIterationAtif(),
        },
      ]));
      const loadedTaxonomy = await taxonomy();

      await expect(loadAtifInputs(plainPath, loadedTaxonomy))
        .resolves.toMatchObject([{
          inputKind: "plain",
          root: "input",
        }]);
      await expect(loadAtifInputs(archivePath, loadedTaxonomy))
        .resolves.toMatchObject([{
          inputKind: "archive",
          root: "input",
          requestId: "request-1",
          runId: "run-1",
        }]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("locates plain-input Scope semantic failures at the original wrapper path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taxonome-atif-"));
    const file = join(directory, "input.json");
    try {
      await writeFile(file, JSON.stringify([{
        schema_version: "ATIF-v1.7",
        agent: { name: "fixture", version: "1.0.0" },
        steps: [],
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
      }]));

      await expect(loadAtifInputResult(file, await taxonomy()))
        .rejects.toMatchObject({
          diagnostic: {
            code: "atif_unknown_scope_surface",
            file,
            original_path:
              "$[0].extra.scope.available_sources[0].surface_id",
          },
        });

    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("locates archive Scope semantic failures in the original iteration", async () => {
    const source = JSON.parse(emptyIterationAtif()) as {
      extra: {
        scope: {
          available_sources: Array<Record<string, unknown>>;
        };
      };
    };
    source.extra.scope.available_sources = [{
      id: "source",
      label: "Source",
      surface_id: "undeclared",
    }];
    const results = await normalizeScopeArchiveRoots(
      await archive([
        { name: "request-1/run.yaml", body: runYaml("done", [1]) },
        {
          name: "request-1/iteration-1.atif.trajectory.json",
          body: JSON.stringify([source]),
        },
      ]),
      await taxonomy(),
      {},
      {},
      { file: "runs.tar.gz" },
    );

    expect(results).toMatchObject([{
      error: {
        diagnostic: {
          code: "atif_unknown_scope_surface",
          file: "runs.tar.gz",
          archive_entry:
            "request-1/iteration-1.atif.trajectory.json",
          original_path:
            "$[0].extra.scope.available_sources[0].surface_id",
        },
      },
    }]);
  });

  it("stitches iterations, rewrites colliding IDs/references, merges tool evidence, and preserves origins", async () => {
    const compressed = await archive([
      { name: "request-1/run.yaml", body: runYaml() },
      { name: "request-1/iteration-1.atif.trajectory.json", body: iterationAtif(1) },
      { name: "request-1/iteration-1.tool-calls.jsonl", body: '{"id":"duplicate-call","name":"account/query","arguments":{},"response":"ok"}\n' },
      { name: "request-1/iteration-2.atif.trajectory.json", body: iterationAtif(2) },
    ]);

    const normalized = await normalizeScopeArchive(compressed, await taxonomy());

    expect(normalized.session_id).toBe("request-1:run-1");
    expect(normalized.steps.map(step => step.step_id)).toEqual([1, 2]);
    expect(normalized.steps.map(step => step.extra?.scope?.origin)).toEqual([
      { iteration: 1, step_id: 1 },
      { iteration: 2, step_id: 1 },
    ]);
    expect(normalized.steps.map(step => step.tool_calls?.[0].tool_call_id)).toEqual([
      "iteration-1:duplicate-call",
      "iteration-2:duplicate-call",
    ]);
    expect(normalized.steps.map(step => step.observation?.results[0].source_call_id)).toEqual([
      "iteration-1:duplicate-call",
      "iteration-2:duplicate-call",
    ]);
    expect(normalized.steps[0].tool_calls?.[0].extra?.scope).toMatchObject({
      origin: { iteration: 1, tool_call_id: "duplicate-call" },
      response: "ok",
      input_validation: {
        status: "invalid",
        issues: [{ code: "missing_field", path: "$.accountId" }],
      },
    });

    expect(normalized.extra?.scope).toMatchObject({
      trajectory_state: "complete",
      task: "Query the account service.",
      run: {
        request_id: "request-1",
        id: "run-1",
        scenario_id: "scenario-1",
        profile_id: "profile-1",
      },
    });
  });

  it("omits absent optional archive run identity fields from canonical ATIF", async () => {
    const manifest = runYaml("done", [1])
      .replace(/^profileId:.*$/m, "");
    const normalized = await normalizeScopeArchive(await archive([
      {
        name: "request-1/run.yaml",
        body: manifest,
      },
      {
        name: "request-1/iteration-1.atif.trajectory.json",
        body: iterationAtif(1),
      },
    ]), await taxonomy());

    expect(normalized.extra?.scope?.run).not.toHaveProperty("profile_id");
    expect(createInputIdentity(normalized).sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("maps generated response failures to the original tool-call JSONL line", async () => {
    const source = JSON.parse(iterationAtif(1)) as {
      steps: Array<Record<string, unknown>>;
    };
    delete source.steps[0].observation;
    await expect(normalizeScopeArchiveRoots(
      await archive([
        { name: "request-1/run.yaml", body: runYaml("done", [1]) },
        {
          name: "request-1/iteration-1.atif.trajectory.json",
          body: JSON.stringify(source),
        },
        {
          name: "request-1/iteration-1.tool-calls.jsonl",
          body:
            '{"id":"duplicate-call","name":"account/query","arguments":{},"response":[{"type":"unknown"}]}\n',
        },
      ]),
      await taxonomy(),
      {},
      {},
      { file: "runs.tar.gz" },
    )).resolves.toMatchObject([{
      error: {
        diagnostic: {
          stage: "scope_normalization",
          file: "runs.tar.gz",
          archive_entry:
            "request-1/iteration-1.tool-calls.jsonl",
          jsonl_line: 1,
          original_path: "$.response[0].type",
        },
      },
    }]);
  });

  it("rebases iteration response mappings through wrapped archive stitching", async () => {
    const source = JSON.parse(iterationAtif(1)) as {
      steps: Array<{
        tool_calls: Array<Record<string, unknown>>;
        observation?: unknown;
      }>;
    };
    delete source.steps[0].observation;
    const call = source.steps[0].tool_calls[0];
    call.extra = {
      scope: {
        response: [{
          type: "text",
          text: "Recorded result.",
        }],
      },
    };
    const results = await normalizeScopeArchiveRoots(
      await archive([
        { name: "request-1/run.yaml", body: runYaml("done", [1]) },
        {
          name: "request-1/iteration-1.atif.trajectory.json",
          body: JSON.stringify([source]),
        },
      ]),
      await taxonomy(),
      {},
      {},
      { file: "runs.tar.gz" },
    );
    const provenance = results[0].provenance!;
    expect(provenance.components).toMatchObject([{
      source_version: "ATIF-v1.7",
      source: {
        archive_entry:
          "request-1/iteration-1.atif.trajectory.json",
      },
      upcasters: [
        { name: "v1.7-to-v1.8" },
      ],
    }]);

    expect(originalAtifPath(
      provenance,
      "$.steps[0].observation.results[0].content",
    )).toMatchObject({
      path:
        "$[0].steps[0].tool_calls[0].extra.scope.response",
      source: {
        file: "runs.tar.gz",
        archive_entry:
          "request-1/iteration-1.atif.trajectory.json",
      },
      generated_by: "scope-response-normalization",
    });
  });

  it("locates malformed archive tool-call JSONL without raw payloads", async () => {
    await expect(normalizeScopeArchiveRoots(
      await archive([
        { name: "request-1/run.yaml", body: runYaml("done", [1]) },
        {
          name: "request-1/iteration-1.atif.trajectory.json",
          body: iterationAtif(1),
        },
        {
          name: "request-1/iteration-1.tool-calls.jsonl",
          body: "\n{\n",
        },
      ]),
      await taxonomy(),
      {},
      {},
      { file: "runs.tar.gz" },
    )).resolves.toMatchObject([{
      error: {
        diagnostic: {
          code: "atif_invalid_archive_tool_call_json",
          stage: "decoding",
          file: "runs.tar.gz",
          archive_entry:
            "request-1/iteration-1.tool-calls.jsonl",
          jsonl_line: 2,
          original_path: "$",
        },
      },
    }]);
  });

  it("rejects cross-iteration references before archive stitching", async () => {
    const first = JSON.parse(iterationAtif(1)) as {
      steps: Array<{
        tool_calls: Array<{ tool_call_id: string }>;
        observation: { results: Array<{ source_call_id: string }> };
      }>;
    };
    first.steps[0].tool_calls[0].tool_call_id = "first-call";
    first.steps[0].observation.results[0].source_call_id = "first-call";
    const second = JSON.parse(emptyIterationAtif()) as {
      steps: Array<Record<string, unknown>>;
    };
    second.steps[0].observation = {
      results: [{ source_call_id: "first-call", content: "reused" }],
    };
    await expect(normalizeScopeArchive(await archive([
      { name: "request-1/run.yaml", body: runYaml("done", [1, 2]) },
      {
        name: "request-1/iteration-1.atif.trajectory.json",
        body: JSON.stringify(first),
      },
      {
        name: "request-1/iteration-2.atif.trajectory.json",
        body: JSON.stringify(second),
      },
    ]), await taxonomy())).rejects.toMatchObject({
      diagnostic: {
        stage: "source_validation",
        archive_entry:
          "request-1/iteration-2.atif.trajectory.json",
        original_path:
          "$.steps[0].observation.results[0].source_call_id",
      },
    });
  });

  it("derives partial completeness from a processing run while preserving explicit timeout evidence", async () => {
    const normalized = await normalizeScopeArchive(await archive([
      { name: "request-1/run.yaml", body: runYaml("processing", [2]) },
      { name: "request-1/iteration-2.atif.trajectory.json", body: iterationAtif(2) },
    ]), await taxonomy());

    expect(normalized.extra?.scope?.trajectory_state).toBe("partial");
    expect(normalized.steps[0].tool_calls?.[0].extra?.scope?.outcome).toBe("timeout");
  });

  it("requires terminal and complete constituent evidence before marking an archive complete", async () => {
    const loaded = await taxonomy();
    const partial = await normalizeScopeArchive(await archive([
      { name: "request-1/run.yaml", body: runYaml("done", [1]) },
      {
        name: "request-1/iteration-1.atif.trajectory.json",
        body: emptyIterationAtif("partial"),
      },
    ]), loaded);
    const unknown = await normalizeScopeArchive(await archive([
      { name: "request-1/run.yaml", body: runYaml("done", [1]) },
      {
        name: "request-1/iteration-1.atif.trajectory.json",
        body: emptyIterationAtif("unknown"),
      },
    ]), loaded);

    expect(partial.extra?.scope?.trajectory_state).toBe("partial");
    expect(unknown.extra?.scope?.trajectory_state).toBe("unknown");
  });

  it("separates requested configuration from explicitly successful availability", async () => {
    const loaded = await taxonomy();
    const failed = await normalizeScopeArchive(await archive([
      {
        name: "request-1/run.yaml",
        body: runYaml("done", [1], {
          mcpRegistered: false,
          resourceSetupSucceeded: false,
        }),
      },
      {
        name: "request-1/iteration-1.atif.trajectory.json",
        body: emptyIterationAtif(),
      },
    ]), loaded);
    expect(failed.extra?.scope).toMatchObject({
      available_sources: [],
      configured_capabilities: {
        mcp_servers: ["account/query"],
        resources: ["account-docs"],
      },
      actual_outcomes: {
        mcp_registered: false,
        resources: [{ slug: "account-docs", setupSucceeded: false }],
      },
    });

    const succeeded = await normalizeScopeArchive(await archive([
      {
        name: "request-1/run.yaml",
        body: runYaml("done", [1], {
          mcpRegistered: true,
          resourceSetupSucceeded: true,
        }),
      },
      {
        name: "request-1/iteration-1.atif.trajectory.json",
        body: emptyIterationAtif(),
      },
    ]), loaded);
    expect(succeeded.extra?.scope?.available_sources).toEqual([
      {
        id: "account/query",
        label: "account/query",
        surface_id: "surface-mcp",
      },
      {
        id: "account-docs",
        label: "account-docs",
        surface_id: "surface-docs",
      },
    ]);
  });

  it("fails when required ATIF is absent even if HAR is present", async () => {
    await expect(normalizeScopeArchive(await archive([
      { name: "request-1/run.yaml", body: runYaml("done", [1]) },
      { name: "request-1/iteration-1.har", body: "{}" },
    ]), await taxonomy())).rejects.toThrow("does not regenerate ATIF from HAR");
  });

  it("rejects unsafe entry types/paths, duplicates, multiple roots, and every configured limit", async () => {
    const loaded = await taxonomy();
    await expect(normalizeScopeArchive(await archive([
      { name: "../run.yaml", body: runYaml() },
    ]), loaded)).rejects.toThrow("Unsafe archive entry path");

    await expect(normalizeScopeArchive(await archive([
      { name: "request-1/run.yaml", type: "symlink", linkname: "/tmp/run.yaml" },
    ]), loaded)).rejects.toThrow("unsupported type");

    await expect(normalizeScopeArchive(await archive([
      { name: "request-1/device", type: "character-device" },
    ]), loaded)).rejects.toThrow("unsupported type");

    await expect(normalizeScopeArchive(await archive([
      { name: "request-1/run.yaml", body: runYaml() },
      { name: "request-1/run.yaml", body: runYaml() },
    ]), loaded)).rejects.toThrow("Duplicate archive entry");

    await expect(normalizeScopeArchive(await archive([
      { name: "request-1/run.yaml", body: runYaml() },
      { name: "request-2/iteration-1.atif.trajectory.json", body: iterationAtif(1) },
    ]), loaded)).rejects.toThrow("exactly one run root");

    await expect(normalizeScopeArchive(await archive([
      { name: "request-1/run.yaml", body: runYaml("done", [1]) },
      { name: "request-1/iteration-1.atif.trajectory.json", body: iterationAtif(1) },
    ]), loaded, { maxStreamedBytes: 100 })).rejects.toThrow("streamed byte limit");

    const valid = await archive([
      { name: "request-1/run.yaml", body: runYaml("done", [1]) },
      { name: "request-1/iteration-1.atif.trajectory.json", body: iterationAtif(1) },
    ]);
    await expect(normalizeScopeArchive(
      valid,
      loaded,
      { maxCompressedBytes: valid.length - 1 },
    )).rejects.toThrow("compressed byte limit");
    await expect(normalizeScopeArchive(valid, loaded, {
      maxEntries: 1,
    })).rejects.toThrow("entry limit");
    await expect(normalizeScopeArchive(await archive([
      { name: "request-1/nested/run.yaml", body: runYaml("done", [1]) },
    ]), loaded, { maxPathDepth: 2 })).rejects.toThrow("path depth");
    await expect(normalizeScopeArchive(
      Buffer.from([0x1f, 0x8b, 0x08, 0x00]),
      loaded,
    )).rejects.toThrow();
  });

  it("discovers multiple roots in archive order while discarding heavy entries", async () => {
    const loaded = await taxonomy();
    const value = await archive([
      { name: "request-2/run.yaml", body: runYaml("done", [1]).replaceAll("request-1", "request-2").replaceAll("run-1", "run-2") },
      { name: "request-2/iteration-1.atif.trajectory.json", body: iterationAtif(1) },
      { name: "request-2/iteration-1.tar.gz", body: "x".repeat(10_000) },
      { name: "request-1/run.yaml", body: runYaml("done", [1]) },
      { name: "request-1/iteration-1.atif.trajectory.json", body: iterationAtif(1) },
    ]);
    const limits = {
      maxCompressedBytes: value.length + 1,
      maxStreamedBytes: 100_000,
      maxRetainedBytes: 100_000,
      maxEntries: 20,
      maxPathDepth: 3,
    };
    const scan = await scanScopeArchive(value, limits);
    expect(scan.roots.map(root => root.root)).toEqual(["request-2", "request-1"]);
    expect([...scan.roots[0].files]).toHaveLength(2);
    expect(scan.streamedBytes).toBeGreaterThan(scan.retainedBytes);

    const normalized = await normalizeScopeArchiveRoots(value, loaded, limits);
    expect(normalized.map(result => result.atif?.session_id)).toEqual([
      "request-2:run-2",
      "request-1:run-1",
    ]);
  });

  it("limits retained evidence independently from discarded archive bytes", async () => {
    const loaded = await taxonomy();
    const value = await archive([
      { name: "request-1/run.yaml", body: runYaml("done", [1]) },
      { name: "request-1/iteration-1.atif.trajectory.json", body: iterationAtif(1) },
      { name: "request-1/iteration-1.tar.gz", body: "x".repeat(10_000) },
    ]);
    await expect(normalizeScopeArchiveRoots(value, loaded, {
      maxStreamedBytes: 100_000,
      maxRetainedBytes: 100,
    })).rejects.toThrow("retained evidence byte limit");
    await expect(normalizeScopeArchiveRoots(value, loaded, {
      maxStreamedBytes: 1_000,
      maxRetainedBytes: 100_000,
    })).rejects.toThrow("streamed byte limit");
  });

  it("normalizes a five-root collection while isolating invalid roots", async () => {
    const loaded = await taxonomy();
    const entries: Array<{ name: string; body: string }> = [];
    for (let index = 1; index <= 5; index++) {
      const request = `request-${index}`;
      entries.push({
        name: `${request}/run.yaml`,
        body: runYaml("done", [1])
          .replaceAll("request-1", request)
          .replaceAll("run-1", `run-${index}`),
      });
      if (index !== 2 && index !== 5) {
        entries.push({
          name: `${request}/iteration-1.atif.trajectory.json`,
          body: iterationAtif(1),
        });
      }
      entries.push({
        name: `${request}/iteration-1.tar.gz`,
        body: "discarded-heavy-entry",
      });
    }
    const results = await normalizeScopeArchiveRoots(
      await archive(entries),
      loaded,
      {},
      {},
      { file: "runs.tar.gz" },
    );
    expect(results.map(result => result.root.root)).toEqual([
      "request-1",
      "request-2",
      "request-3",
      "request-4",
      "request-5",
    ]);
    expect(results.map(result => Boolean(result.atif))).toEqual([
      true,
      false,
      true,
      true,
      false,
    ]);
    expect(results[0].provenance?.source.file).toBe("runs.tar.gz");
    expect(originalAtifPath(
      results[0].provenance!,
      "$.steps[0].message",
    )).toMatchObject({
      path: "$.steps[0].message",
      source: {
        file: "runs.tar.gz",
        archive_entry:
          "request-1/iteration-1.atif.trajectory.json",
      },
      generated_by: "scope-archive-stitching",
    });
    expect(results.filter(result => result.error)).toHaveLength(2);
  });

  it("preserves archive media and canonicalizes every root to v1.8", async () => {
    const loaded = await taxonomy();
    const singleV18 = await normalizeScopeArchive(
      await archive([
        { name: "request-v18/run.yaml", body: runYaml("done", [1])
          .replaceAll("request-1", "request-v18")
          .replaceAll("run-1", "run-v18") },
        {
          name: "request-v18/iteration-1.atif.trajectory.json",
          body: iterationAtifV18(1),
        },
      ]),
      loaded,
    );
    expect(singleV18.schema_version).toBe("ATIF-v1.8");
    expect(singleV18.agent).toMatchObject({
      name: "fixture",
      version: "2.0.0",
    });
    expect(singleV18.steps[0].message).toEqual([
      { type: "text", text: "Iteration 1" },
      {
        type: "audio",
        source: {
          media_type: "audio/mpeg",
          path: "audio/message-1.mp3",
        },
      },
    ]);
    expect(singleV18.steps[0].observation?.results[0].content).toEqual([{
      type: "audio",
      source: {
        media_type: "audio/wav",
        path: "audio/result-1.wav",
        duration_sec: 2,
      },
    }]);

    const mixed = await normalizeScopeArchive(
      await archive([
        { name: "request-mixed/run.yaml", body: runYaml("done", [1, 2])
          .replaceAll("request-1", "request-mixed")
          .replaceAll("run-1", "run-mixed") },
        {
          name: "request-mixed/iteration-1.atif.trajectory.json",
          body: iterationAtif(1),
        },
        {
          name: "request-mixed/iteration-2.atif.trajectory.json",
          body: iterationAtifV18(2),
        },
      ]),
      loaded,
    );
    expect(mixed.schema_version).toBe("ATIF-v1.8");

    const roots = await normalizeScopeArchiveRoots(
      await archive([
        { name: "request-v17/run.yaml", body: runYaml("done", [1])
          .replaceAll("request-1", "request-v17")
          .replaceAll("run-1", "run-v17") },
        {
          name: "request-v17/iteration-1.atif.trajectory.json",
          body: iterationAtif(1),
        },
        { name: "request-v18/run.yaml", body: runYaml("done", [1])
          .replaceAll("request-1", "request-v18")
          .replaceAll("run-1", "run-v18") },
        {
          name: "request-v18/iteration-1.atif.trajectory.json",
          body: iterationAtifV18(1),
        },
      ]),
      loaded,
    );
    expect(roots.map(root => root.atif?.schema_version)).toEqual([
      "ATIF-v1.8",
      "ATIF-v1.8",
    ]);
  });

  it("reports compressed, tar, root, streamed, and retained progress", async () => {
    const value = await archive([
      { name: "request-1/run.yaml", body: runYaml("done", [1]) },
      { name: "request-1/iteration-1.atif.trajectory.json", body: iterationAtif(1) },
      { name: "request-1/iteration-1.tar.gz", body: "discarded" },
    ]);
    const progress: Array<{
      compressedBytes: number;
      compressedTotalBytes?: number;
      entryCount: number;
      rootCount: number;
      streamedBytes: number;
      retainedBytes: number;
      complete: boolean;
    }> = [];
    const limits = {
      maxCompressedBytes: value.length + 1,
      maxStreamedBytes: 100_000,
      maxRetainedBytes: 100_000,
      maxEntries: 20,
      maxPathDepth: 3,
    };
    const scan = await scanScopeArchive(value, limits, {
      onProgress: event => progress.push(event),
    });

    expect(progress.at(-1)).toEqual({
      compressedBytes: value.length,
      compressedTotalBytes: value.length,
      entryCount: 3,
      rootCount: 1,
      streamedBytes: scan.streamedBytes,
      retainedBytes: scan.retainedBytes,
      complete: true,
    });
    expect(progress.some(event => event.entryCount > 0)).toBe(true);
    expect(progress.some(event => event.rootCount === 1)).toBe(true);
    expect(progress.some(event => event.streamedBytes > event.retainedBytes)).toBe(true);
  });

  it("supports unknown compressed totals and aborts streaming scans", async () => {
    const value = await archive([
      { name: "request-1/run.yaml", body: runYaml("done", [1]) },
      { name: "request-1/iteration-1.atif.trajectory.json", body: iterationAtif(1) },
    ]);
    const progress: Array<{ compressedTotalBytes?: number }> = [];
    const limits = {
      maxCompressedBytes: value.length + 1,
      maxStreamedBytes: 100_000,
      maxRetainedBytes: 100_000,
      maxEntries: 20,
      maxPathDepth: 3,
    };
    await scanScopeArchive(Readable.from([value]), limits, {
      onProgress: event => progress.push(event),
    });
    expect(progress.every(event => event.compressedTotalBytes === undefined)).toBe(true);
    await expect(scanScopeArchive(Readable.from([value]), {
      ...limits,
      maxCompressedBytes: value.length - 1,
    })).rejects.toThrow("compressed byte limit");

    const controller = new AbortController();
    await expect(scanScopeArchive(
      Readable.from((async function* () {
        yield value.subarray(0, Math.ceil(value.length / 2));
        await new Promise(resolve => setTimeout(resolve, 20));
        yield value.subarray(Math.ceil(value.length / 2));
      })()),
      limits,
      {
        signal: controller.signal,
        onProgress: event => {
          if (event.compressedBytes > 0) controller.abort();
        },
      },
    )).rejects.toThrow();
  });
});
