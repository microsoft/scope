// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { ingestAtif } from "../ingest.js";
import { AtifIngestionError } from "../types.js";

type MutableTrajectory = {
  schema_version: string;
  agent: Record<string, unknown>;
  steps: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

function source(
  version: "ATIF-v1.6" | "ATIF-v1.7" | "ATIF-v1.8",
): MutableTrajectory {
  return {
    schema_version: version,
    ...(version === "ATIF-v1.6" ? { session_id: "session-1" } : {}),
    agent: { name: "agent", version: "1.0.0" },
    steps: [{
      step_id: 1,
      source: "agent",
      message: "done",
      tool_calls: [{
        tool_call_id: "call-1",
        function_name: "tool",
        arguments: {},
      }],
      observation: {
        results: [{ source_call_id: "call-1", content: "done" }],
      },
    }],
  };
}

describe("ATIF historical validators", () => {
  it.each([
    ["v1.6 trajectory_id", "ATIF-v1.6", (raw: MutableTrajectory) => {
      raw.trajectory_id = "not-legal";
    }],
    ["v1.6 tool-call extra", "ATIF-v1.6", (raw: MutableTrajectory) => {
      const call = (
        raw.steps as Array<Record<string, unknown>>
      )[0].tool_calls as Array<Record<string, unknown>>;
      call[0].extra = { vendor: true };
    }],
    ["v1.6 llm_call_count", "ATIF-v1.6", (raw: MutableTrajectory) => {
      (raw.steps as Array<Record<string, unknown>>)[0].llm_call_count = 1;
    }],
    ["v1.7 audio", "ATIF-v1.7", (raw: MutableTrajectory) => {
      (raw.steps as Array<Record<string, unknown>>)[0].message = [{
        type: "audio",
        source: { media_type: "audio/wav", path: "audio.wav" },
      }];
    }],
  ] as const)("rejects illegal historical feature: %s", (
    _label,
    version,
    mutate,
  ) => {
    const raw: MutableTrajectory = source(version);
    mutate(raw);

    expect(() => ingestAtif(raw)).toThrow(AtifIngestionError);
  });

  it("allows v1.7 call/result extra and upcasts it unchanged", () => {
    const raw = source("ATIF-v1.7");
    const step = raw.steps[0];
    const calls = step.tool_calls as Array<Record<string, unknown>>;
    const observation = step.observation as {
      results: Array<Record<string, unknown>>;
    };
    calls[0].extra = { vendor: { keep: true } };
    observation.results[0].extra = {
      vendor: { keep: true },
    };

    const atif = ingestAtif(raw).atif;
    expect(atif.steps[0].tool_calls?.[0].extra).toEqual({
      vendor: { keep: true },
    });
    expect(atif.steps[0].observation?.results[0].extra).toEqual({
      vendor: { keep: true },
    });
  });

  it("accepts v1.8 audio and normalizes reviewed MIME aliases", () => {
    const raw = source("ATIF-v1.8");
    raw.steps[0].message = [{
      type: "audio",
      source: { media_type: "audio/x-wav", path: "audio.wav" },
    }];

    expect(ingestAtif(raw).atif.steps[0].message).toEqual([{
      type: "audio",
      source: { media_type: "audio/wav", path: "audio.wav" },
    }]);
  });

  it("validates children under their own version and recursively upcasts", () => {
    const raw = source("ATIF-v1.7");
    raw.session_id = "shared-session";
    raw.subagent_trajectories = [{
      ...source("ATIF-v1.7"),
      trajectory_id: "child-1",
      session_id: "shared-session",
    }];

    const atif = ingestAtif([raw]).atif;
    expect(atif.subagent_trajectories).toMatchObject([{
      schema_version: "ATIF-v1.8",
      trajectory_id: "child-1",
      session_id: "shared-session",
    }]);
  });

  it("allows a v1.7 parent to embed independently valid v1.8 audio", () => {
    const raw = source("ATIF-v1.7");
    const child = source("ATIF-v1.8");
    child.trajectory_id = "audio-child";
    child.steps[0].message = [{
      type: "audio",
      source: { media_type: "audio/mp3", path: "x.mp3" },
    }];
    raw.subagent_trajectories = [child];

    const atif = ingestAtif(raw).atif;
    expect(atif.subagent_trajectories).toMatchObject([{
      schema_version: "ATIF-v1.8",
      steps: [{
        message: [{
          type: "audio",
          source: { media_type: "audio/mpeg", path: "x.mp3" },
        }],
      }],
    }]);
  });

  it.each([
    ["duplicate call", (raw: MutableTrajectory) => {
      const step = raw.steps[0];
      step.tool_calls = [
        {
          tool_call_id: "duplicate",
          function_name: "one",
          arguments: {},
        },
        {
          tool_call_id: "duplicate",
          function_name: "two",
          arguments: {},
        },
      ];
      step.observation = {
        results: [{
          source_call_id: "duplicate",
          content: "Result.",
        }],
      };
    }, "$[0].steps[0].tool_calls[1].tool_call_id"],
    ["unknown observation call", (raw: MutableTrajectory) => {
      const step = raw.steps[0];
      step.observation = {
        results: [{
          source_call_id: "missing",
          content: "Result.",
        }],
      };
    }, "$[0].steps[0].observation.results[0].source_call_id"],
  ] as const)("rejects invalid document identity links: %s", (
    _label,
    mutate,
    originalPath,
  ) => {
    const raw = source("ATIF-v1.8");
    mutate(raw);
    try {
      ingestAtif([raw], { file: "links.json" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AtifIngestionError);
      expect((error as AtifIngestionError).diagnostic).toMatchObject({
        stage: "source_validation",
        original_path: originalPath,
      });
    }
  });

  it("reports unsupported v1.7 audio at the original part discriminator", () => {
    const raw = source("ATIF-v1.7");
    raw.steps[0].message = [{
      type: "audio",
      source: { media_type: "audio/mp3", path: "x.mp3" },
    }];

    try {
      ingestAtif([raw], { file: "audio.json" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AtifIngestionError);
      expect((error as AtifIngestionError).diagnostic).toMatchObject({
        stage: "source_validation",
        original_path: "$[0].steps[0].message[0].type",
      });
    }
  });
});
