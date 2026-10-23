// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import { stringify as yamlStringify } from "yaml";
import { describe, expect, it } from "vitest";
import { createHandlerRegistry } from "./handlers.js";
import { normalizeScopeArchive } from "./archive.js";
import { loadTaxonomy } from "./taxonomy.js";

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
    agent: { name: "fixture" },
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
    agent: { name: "fixture" },
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

async function taxonomy() {
  return loadTaxonomy(
    new URL("../fixtures/test-taxonomy.yaml", import.meta.url).pathname,
    { handlers: createHandlerRegistry() },
  );
}

describe("Scope run archive normalization", () => {
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

  it("rewrites an unambiguous cross-iteration observation call reference", async () => {
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
    const normalized = await normalizeScopeArchive(await archive([
      { name: "request-1/run.yaml", body: runYaml("done", [1, 2]) },
      {
        name: "request-1/iteration-1.atif.trajectory.json",
        body: JSON.stringify(first),
      },
      {
        name: "request-1/iteration-2.atif.trajectory.json",
        body: JSON.stringify(second),
      },
    ]), await taxonomy());

    expect(normalized.steps[1].observation?.results[0].source_call_id).toBe(
      "first-call",
    );
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
    ]), loaded, { maxExpandedBytes: 100 })).rejects.toThrow("expanded byte limit");

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
});
