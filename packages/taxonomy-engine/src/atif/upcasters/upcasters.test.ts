// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { ingestAtif } from "../ingest.js";
import { createAtifProvenance } from "../source-map.js";
import { AtifIngestionError } from "../types.js";
import { upcastV17ToV18 } from "./v1.7-to-v1.8.js";
import type { AtifV17 } from "../validators/v1.7.js";

interface MutableSource {
  schema_version: string;
  steps: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

function source(
  version: "ATIF-v1.6" | "ATIF-v1.7",
): MutableSource {
  return {
    schema_version: version,
    ...(version === "ATIF-v1.6" ? { session_id: "session-1" } : {}),
    agent: { name: "agent", version: "1.0.0" },
    steps: [{ step_id: 1, source: "user", message: "task" }],
    extra: { vendor: { keep: true } },
  };
}

describe("ATIF adjacent upcasters", () => {
  it("upcasts v1.6 through v1.7 to canonical v1.8", () => {
    const raw = source("ATIF-v1.6");
    const result = ingestAtif(raw, { file: "v16.json" });

    expect(result.atif).toMatchObject({
      schema_version: "ATIF-v1.8",
      session_id: "session-1",
      extra: { vendor: { keep: true } },
    });
    expect(result.provenance.upcasters.map(step => step.name)).toEqual([
      "v1.6-to-v1.7",
      "v1.7-to-v1.8",
    ]);
    expect(raw.schema_version).toBe("ATIF-v1.6");
  });

  it("upcasts v1.7 through the normal canonical path", () => {
    const raw = source("ATIF-v1.7");
    raw.subagent_trajectories = [{
      ...source("ATIF-v1.7"),
      trajectory_id: "child",
    }];
    const result = upcastV17ToV18(
      raw as AtifV17,
      createAtifProvenance(
        { file: "v17.json" },
        "$",
        "ATIF-v1.7",
      ),
    );
    const output = result.value as Record<string, unknown>;

    expect(output.schema_version).toBe("ATIF-v1.8");
    expect(raw.schema_version).toBe("ATIF-v1.7");
    expect(
      (
        raw.subagent_trajectories as Array<Record<string, unknown>>
      )[0].schema_version,
    ).toBe("ATIF-v1.7");
    expect(output.subagent_trajectories).toMatchObject([{
      schema_version: "ATIF-v1.8",
    }]);
    expect(result.provenance.upcasters.map(step => step.name)).toEqual([
      "v1.7-to-v1.8",
      "v1.7-to-v1.8",
    ]);
  });

  it("rejects unresolved v1.6 session-only subagent references in place", () => {
    const raw = source("ATIF-v1.6");
    raw.steps = [{
      step_id: 1,
      source: "user",
      message: "task",
      observation: {
        results: [{
          content: "child",
          subagent_trajectory_ref: [{ session_id: "child-session" }],
        }],
      },
    }];

    try {
      ingestAtif([raw], { file: "legacy.json" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AtifIngestionError);
      expect((error as AtifIngestionError).diagnostic).toMatchObject({
        code: "atif_upcast_unresolvable_subagent",
        stage: "upcasting",
        file: "legacy.json",
        original_path:
          "$[0].steps[0].observation.results[0].subagent_trajectory_ref[0]",
        source_version: "ATIF-v1.6",
        target_version: "ATIF-v1.7",
        upcaster: "v1.6-to-v1.7",
      });
    }
  });
});
