// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { canonicalJsonSha256 } from "../canonical-json.js";
import { ingestAtif, ingestAtifJson } from "./ingest.js";
import {
  addAtifMapping,
  createAtifProvenance,
  originalAtifPath,
} from "./source-map.js";
import { AtifIngestionError } from "./types.js";
import { freezeTaxonomyInput } from "../scope-atif.js";

type MutableTrajectory = {
  schema_version: string;
  agent: Record<string, unknown>;
  steps: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

function trajectory(
  version: "ATIF-v1.6" | "ATIF-v1.7" | "ATIF-v1.8",
): MutableTrajectory {
  return {
    schema_version: version,
    ...(version === "ATIF-v1.6" ? { session_id: "session-1" } : {}),
    agent: { name: "test-agent", version: "1.0.0" },
    steps: [{
      step_id: 1,
      source: "user",
      message: "Do the task.",
    }],
  };
}

describe("ATIF ingestion", () => {
  it.each([
    ["bare object", trajectory("ATIF-v1.8"), "$"],
    ["singleton wrapper", [trajectory("ATIF-v1.8")], "$[0]"],
  ] as const)("accepts a %s", (_label, input, prefix) => {
    const result = ingestAtif(input, { file: "input.json" });

    expect(result.atif.schema_version).toBe("ATIF-v1.8");
    expect(result.provenance.container_prefix).toBe(prefix);
    expect(result.provenance.source.file).toBe("input.json");
  });

  it.each([
    ["empty array", []],
    ["multi-item array", [trajectory("ATIF-v1.8"), trajectory("ATIF-v1.8")]],
    ["nested array", [[trajectory("ATIF-v1.8")]]],
    ["null entry", [null]],
    ["primitive root", "ATIF-v1.8"],
  ])("rejects %s containers", (_label, input) => {
    expect(() => ingestAtif(input, { file: "bad.json" }))
      .toThrow(AtifIngestionError);
  });

  it("reports invalid JSON against the original file root", () => {
    try {
      ingestAtifJson("{", { file: "broken.json" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AtifIngestionError);
      expect((error as AtifIngestionError).diagnostic).toMatchObject({
        code: "atif_invalid_json",
        stage: "decoding",
        file: "broken.json",
        original_path: "$",
      });
    }
  });

  it.each([
    "token=SYNTHETIC_ATIF_SECRET_123",
    `ATIF-${"x".repeat(5_000)}`,
  ])("bounds unsupported-version diagnostics without echoing raw values", version => {
    try {
      ingestAtif([{
        ...trajectory("ATIF-v1.8"),
        schema_version: version,
      }], { file: "input.json" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AtifIngestionError);
      const ingestionError = error as AtifIngestionError;
      expect(ingestionError.diagnostic.message.length).toBeLessThan(2_000);
      expect(ingestionError.diagnostic.message).not.toContain(
        "SYNTHETIC_ATIF_SECRET_123",
      );
      expect(ingestionError.diagnostic.message).not.toContain("xxxx");
      expect(ingestionError.message).not.toContain(
        "SYNTHETIC_ATIF_SECRET_123",
      );
    }
  });

  it.each([
    ["missing agent version", (raw: MutableTrajectory) => {
      delete raw.agent.version;
    }, "$.agent.version"],
    ["non-object arguments", (raw: MutableTrajectory) => {
      const step = raw.steps[0];
      step.source = "agent";
      step.tool_calls = [{
        tool_call_id: "call-1",
        function_name: "tool",
        arguments: "not-an-object",
      }];
    }, "$.steps[0].tool_calls[0].arguments"],
    ["nonsequential step ID", (raw: MutableTrajectory) => {
      raw.steps.push({
        step_id: 1,
        source: "agent",
        message: "duplicate",
      });
    }, "$.steps[1].step_id"],
    ["agent-only field on user step", (raw: MutableTrajectory) => {
      raw.steps[0].tool_calls = [];
    }, "$.steps[0].tool_calls"],
  ] as const)("rejects strict core violation: %s", (
    _label,
    mutate,
    expectedPath,
  ) => {
    const raw = trajectory("ATIF-v1.8");
    mutate(raw);

    try {
      ingestAtif(raw, { file: "strict.json" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AtifIngestionError);
      expect((error as AtifIngestionError).diagnostic).toMatchObject({
        code: "atif_invalid_source",
        stage: "source_validation",
        file: "strict.json",
        original_path: expectedPath,
      });
    }
  });

  it("retains official inactive null content fields", () => {
    const raw = trajectory("ATIF-v1.8");
    raw.steps[0].message = [
      { type: "text", text: "hello", source: null },
      {
        type: "image",
        source: { media_type: "image/png", path: "image.png" },
        text: null,
      },
      {
        type: "audio",
        source: {
          media_type: "audio/wav",
          path: "audio.wav",
          duration_sec: null,
        },
        text: null,
      },
    ];

    expect(ingestAtif(raw).atif.steps[0].message).toEqual(
      raw.steps[0].message,
    );
  });

  it("maps generated response validation errors to extra.scope.response", () => {
    const raw = trajectory("ATIF-v1.8");
    const step = raw.steps[0];
    step.source = "agent";
    step.tool_calls = [{
      tool_call_id: "call-1",
      function_name: "tool",
      arguments: {},
      extra: {
        scope: {
          response: [{ type: "unknown" }],
        },
      },
    }];

    try {
      ingestAtif(raw, { file: "response.json" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AtifIngestionError);
      expect((error as AtifIngestionError).diagnostic).toMatchObject({
        stage: "scope_normalization",
        file: "response.json",
        original_path:
          "$.steps[0].tool_calls[0].extra.scope.response[0].type",
        generated_by: "scope-response-normalization",
      });
    }
  });

  it.each([
    ["root", (raw: MutableTrajectory) => {
      raw.extra = {
        scope: {
          schema_version: "scope.atif-extension.v1",
          task: 42,
        },
      };
    }, "$[0].extra.scope.task"],
    ["step", (raw: MutableTrajectory) => {
      raw.steps[0].extra = {
        scope: { discoveries: [{ source_id: 42, extension_point: "x" }] },
      };
    }, "$[0].steps[0].extra.scope.discoveries[0].source_id"],
    ["call", (raw: MutableTrajectory) => {
      raw.steps[0] = {
        step_id: 1,
        source: "agent",
        message: "call",
        tool_calls: [{
          tool_call_id: "call-1",
          function_name: "tool",
          arguments: {},
          extra: { scope: { source_id: 42 } },
        }],
      };
    }, "$[0].steps[0].tool_calls[0].extra.scope.source_id"],
  ] as const)("locates invalid %s Scope metadata", (
    _label,
    mutate,
    expectedPath,
  ) => {
    const raw = trajectory("ATIF-v1.8");
    mutate(raw);
    try {
      ingestAtif([raw], { file: "source.json" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AtifIngestionError);
      expect((error as AtifIngestionError).diagnostic).toMatchObject({
        code: "atif_invalid_scope_extension",
        file: "source.json",
        original_path: expectedPath,
      });
    }
  });

  it("validates embedded subagent trajectories recursively", () => {
    const raw = trajectory("ATIF-v1.8");
    raw.subagent_trajectories = [{
      ...trajectory("ATIF-v1.8"),
      trajectory_id: "child-1",
    }];
    expect(ingestAtif(raw).atif.subagent_trajectories).toHaveLength(1);

    for (const children of [
      [{ junk: true }],
      [{ ...trajectory("ATIF-v1.8") }],
      [
        { ...trajectory("ATIF-v1.8"), trajectory_id: "duplicate" },
        { ...trajectory("ATIF-v1.8"), trajectory_id: "duplicate" },
      ],
    ]) {
      expect(() => ingestAtif({
        ...raw,
        subagent_trajectories: children,
      })).toThrow(AtifIngestionError);
    }
  });

  it("matches source-map prefixes by structured selector segments", () => {
    let provenance = createAtifProvenance(
      { file: "quoted.json" },
      "$[0]",
      "ATIF-v1.8",
    );
    provenance = addAtifMapping(provenance, {
      normalized_prefix:
        "$.steps[0].observation.results[0].content",
      original_prefix:
        "$[0].steps[0].tool_calls[0].extra.scope.response",
      generated_by: "scope-response-normalization",
    });

    expect(originalAtifPath(
      provenance,
      '$["steps"][0]["observation"]["results"][0]["content"][1]',
    )).toMatchObject({
      path:
        "$[0].steps[0].tool_calls[0].extra.scope.response[1]",
      generated_by: "scope-response-normalization",
    });
  });

  it("anchors generated defaults and lets the newest equal mapping win", () => {
    let provenance = createAtifProvenance(
      { file: "defaults.json" },
      "$[0]",
      "ATIF-v1.8",
    );
    provenance = addAtifMapping(provenance, {
      normalized_prefix: "$.extra.scope",
      original_prefix: "$[0]",
      generated_by: "old-default",
      mode: "anchor",
    });

    provenance = addAtifMapping(provenance, {
      normalized_prefix: "$.extra.scope",
      original_prefix: "$[0].extra",
      generated_by: "scope-defaults",
      mode: "anchor",
    });

    expect(originalAtifPath(
      provenance,
      "$.extra.scope.available_sources",
    )).toMatchObject({
      path: "$[0].extra",
      generated_by: "scope-defaults",
    });
  });

  it.each([
    ['$["key]with-bracket"]', '$[0]["key]with-bracket"]'],
    [
      '$["quote\\\"and]bracket"]',
      '$[0]["quote\\\"and]bracket"]',
    ],
    [
      "$['single\\'and]bracket']",
      '$[0]["single\'and]bracket"]',
    ],
  ])("maps quoted source keys containing brackets: %s", (
    normalizedPath,
    originalPath,
  ) => {
    const provenance = createAtifProvenance(
      { file: "quoted.json" },
      "$[0]",
      "ATIF-v1.8",
    );

    expect(originalAtifPath(provenance, normalizedPath).path)
      .toBe(originalPath);
  });

  it("keeps source provenance outside the normalized evidence hash", async () => {
    const file = new URL(
      "../../conformance/trajectory-taxonomy-format/valid/atif-v18-mixed-media.json",
      import.meta.url,
    );
    const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
    const first = ingestAtif(raw, { file: "first.json" });
    const second = ingestAtif(raw, {
      file: "second.json",
      archive_entry: "runs/2/trajectory.json",
      jsonl_line: 8,
    });

    expect(canonicalJsonSha256(first.atif)).toBe(
      "193a61263eb1b92a89e074b5d216759297410ed9a306a7308b4af0f7f29fc396",
    );
    expect(canonicalJsonSha256(second.atif))
      .toBe(canonicalJsonSha256(first.atif));
    expect(second.provenance).not.toEqual(first.provenance);
  });

  it("isolates caller-owned opaque values while preserving safe output sharing", () => {
    const sharedOpaque = {
      deep: { value: "original" },
    };
    const raw = trajectory("ATIF-v1.8");
    raw.extra = { vendor: sharedOpaque };
    raw.agent.extra = { vendor: sharedOpaque };
    raw.steps[0] = {
      step_id: 1,
      source: "agent",
      message: "call",
      tool_calls: [{
        tool_call_id: "call-1",
        function_name: "tool",
        arguments: { payload: sharedOpaque },
        extra: { vendor: sharedOpaque },
      }],
    };

    const result = ingestAtif(raw);
    const rootVendor = (
      result.atif.extra as Record<string, unknown>
    ).vendor as typeof sharedOpaque;
    const agentVendor = (
      result.atif.agent.extra as Record<string, unknown>
    ).vendor as typeof sharedOpaque;
    const call = result.atif.steps[0].tool_calls![0];
    const argumentVendor = call.arguments.payload as typeof sharedOpaque;
    const callVendor = (
      call.extra as Record<string, unknown>
    ).vendor as typeof sharedOpaque;
    const fingerprint = canonicalJsonSha256(result.atif);

    expect(rootVendor).not.toBe(sharedOpaque);
    expect(agentVendor).toBe(rootVendor);
    expect(argumentVendor).toBe(rootVendor);
    expect(callVendor).toBe(rootVendor);

    sharedOpaque.deep.value = "caller-mutated";
    expect(rootVendor.deep.value).toBe("original");
    expect(canonicalJsonSha256(result.atif)).toBe(fingerprint);

    rootVendor.deep.value = "output-mutated";
    expect(sharedOpaque.deep.value).toBe("caller-mutated");
    freezeTaxonomyInput(result.atif);
    expect(Object.isFrozen(sharedOpaque)).toBe(false);
    expect(Object.isFrozen(sharedOpaque.deep)).toBe(false);
  });
});
