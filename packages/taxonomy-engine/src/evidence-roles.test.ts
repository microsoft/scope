// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evidenceTypeSchema,
  type Assessment,
  type EvidenceContract,
  type EvidenceRole,
  type EvidenceType,
} from "./assessment.js";
import { validateAssessment } from "./evidence.js";
import { createHandlerRegistry } from "./handlers.js";
import {
  parseScopeAtif,
  type ScopeAtif,
} from "./scope-atif.js";
import { loadTaxonomy } from "./taxonomy.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true })
  ));
});

function typedAtif(): ScopeAtif {
  return parseScopeAtif({
    schema_version: "ATIF-v1.8",
    trajectory_id: "typed-evidence",
    agent: { name: "fixture", version: "1.0.0" },
    steps: [
      {
        step_id: 1,
        source: "agent",
        message: [
          { type: "text", text: "Text." },
          {
            type: "image",
            source: {
              media_type: "image/png",
              path: "images/evidence.png",
            },
          },
          {
            type: "audio",
            source: {
              media_type: "audio/wav",
              path: "audio/evidence.wav",
            },
          },
        ],
        tool_calls: [{
          tool_call_id: "call-0",
          function_name: "query",
          arguments: {},
          extra: {
            scope: {
              input_validation: {
                status: "invalid",
                issues: [{ code: "missing_field" }],
              },
              response: {
                lookalikes: {
                  step: {
                    step_id: 99,
                    source: "agent",
                    message: "Lookalike.",
                  },
                  tool_call: {
                    tool_call_id: "lookalike",
                    function_name: "query",
                    arguments: {},
                  },
                  observation: { results: [] },
                  observation_result: {
                    source_call_id: "call-0",
                    content: "Lookalike.",
                  },
                  content_part: { type: "text", text: "Lookalike." },
                  image_source: {
                    media_type: "image/png",
                    path: "images/lookalike.png",
                  },
                  audio_source: {
                    media_type: "audio/wav",
                    path: "audio/lookalike.wav",
                  },
                  discovery: {
                    source_id: "source",
                    extension_point: "query",
                  },
                  input_validation_issue: {
                    code: "missing_field",
                  },
                },
              },
            },
          },
        }],
        observation: {
          results: [{
            source_call_id: "call-0",
            content: [
              { type: "text", text: "Result." },
              {
                type: "image",
                source: {
                  media_type: "image/webp",
                  path: "images/result.webp",
                },
              },
              {
                type: "audio",
                source: {
                  media_type: "audio/mpeg",
                  path: "audio/result.mp3",
                },
              },
            ],
          }],
        },
        extra: {
          scope: {
            discoveries: [{
              source_id: "source",
              extension_point: "query",
            }],
          },
        },
      },
      { step_id: 2, source: "agent", message: "Second." },
      { step_id: 3, source: "agent", message: "Third." },
    ],
    extra: {
      scope: {
        schema_version: "scope.atif-extension.v1",
        trajectory_state: "complete",
        available_sources: [],
      },
    },
  });
}

interface TypeCase {
  validPath: string;
  lookalikePath: string;
}

const TYPE_CASES = {
  "atif.step": {
    validPath: "$.steps[0]",
    lookalikePath:
      "$.steps[0].tool_calls[0].extra.scope.response.lookalikes.step",
  },
  "atif.tool_call": {
    validPath: "$.steps[0].tool_calls[0]",
    lookalikePath:
      "$.steps[0].tool_calls[0].extra.scope.response.lookalikes.tool_call",
  },
  "atif.observation": {
    validPath: "$.steps[0].observation",
    lookalikePath:
      "$.steps[0].tool_calls[0].extra.scope.response.lookalikes.observation",
  },
  "atif.observation_result": {
    validPath: "$.steps[0].observation.results[0]",
    lookalikePath:
      "$.steps[0].tool_calls[0].extra.scope.response.lookalikes.observation_result",
  },
  "atif.content_part": {
    validPath: "$.steps[0].message[0]",
    lookalikePath:
      "$.steps[0].tool_calls[0].extra.scope.response.lookalikes.content_part",
  },
  "atif.image_source": {
    validPath: "$.steps[0].message[1].source",
    lookalikePath:
      "$.steps[0].tool_calls[0].extra.scope.response.lookalikes.image_source",
  },
  "atif.audio_source": {
    validPath: "$.steps[0].message[2].source",
    lookalikePath:
      "$.steps[0].tool_calls[0].extra.scope.response.lookalikes.audio_source",
  },
  "scope.discovery": {
    validPath: "$.steps[0].extra.scope.discoveries[0]",
    lookalikePath:
      "$.steps[0].tool_calls[0].extra.scope.response.lookalikes.discovery",
  },
  "scope.input_validation_issue": {
    validPath:
      "$.steps[0].tool_calls[0].extra.scope.input_validation.issues[0]",
    lookalikePath:
      "$.steps[0].tool_calls[0].extra.scope.response.lookalikes.input_validation_issue",
  },
} satisfies Record<EvidenceType, TypeCase>;

function contract(
  evidenceRoles: Record<string, EvidenceRole>,
): EvidenceContract {
  return { evidence_roles: evidenceRoles, constraints: [] };
}

function positive(
  references: Array<[role: string, path: string]>,
): Assessment {
  return {
    state: "completed",
    observed: true,
    occurrences: [{
      evidence: references.map(([role, path]) => ({ role, path })),
    }],
  };
}

describe("shared evidence type registry coverage", () => {
  it("has an explicit positive and wrong-location fixture for every type", () => {
    expect(Object.keys(TYPE_CASES).sort())
      .toEqual([...evidenceTypeSchema.options].sort());
  });

  it.each(Object.entries(TYPE_CASES))(
    "%s resolves only at its registered structural location",
    (type, fixture) => {
      const evidenceType = type as EvidenceType;
      const output = contract({
        evidence: {
          type: evidenceType,
          description: `Evidence for ${evidenceType}.`,
          min: 1,
          max: 1,
        },
      });
      expect(validateAssessment(
        positive([["evidence", fixture.validPath]]),
        output,
        typedAtif(),
      ).diagnostics).toEqual([]);
      const invalid = validateAssessment(
        positive([["evidence", fixture.lookalikePath]]),
        output,
        typedAtif(),
      );
      expect(invalid.diagnostics.map(value => value.code))
        .toContain("reference_type_mismatch");
    },
  );

  it.each(
    Object.entries(TYPE_CASES).flatMap(([expectedType]) =>
      Object.entries(TYPE_CASES)
        .filter(([actualType]) => actualType !== expectedType)
        .map(([actualType, actualFixture]) => ({
          expectedType: expectedType as EvidenceType,
          actualType: actualType as EvidenceType,
          actualPath: actualFixture.validPath,
        }))
    ),
  )(
    "$expectedType rejects registered $actualType evidence",
    ({ expectedType, actualType, actualPath }) => {
      const result = validateAssessment(
        positive([["evidence", actualPath]]),
        contract({
          evidence: {
            type: expectedType,
            description: `Expected ${expectedType}.`,
            min: 1,
            max: 1,
          },
        }),
        typedAtif(),
      );
      expect(result.assessment).toBeUndefined();
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: "reference_type_mismatch",
          expected_type: expectedType,
          actual_type: actualType,
        }),
      ]);
    },
  );
});

describe("evidence role usage and occurrence-local cardinality", () => {
  const step = (min = 1, max?: number): EvidenceRole => ({
    type: "atif.step",
    description: "Step evidence.",
    min,
    ...(max === undefined ? {} : { max }),
  });

  it.each([
    {
      label: "below minimum fails",
      role: step(2, 2),
      paths: ["$.steps[0]"],
      valid: false,
    },
    {
      label: "exact minimum and maximum passes",
      role: step(2, 2),
      paths: ["$.steps[0]", "$.steps[1]"],
      valid: true,
    },
    {
      label: "above maximum fails",
      role: step(2, 2),
      paths: ["$.steps[0]", "$.steps[1]", "$.steps[2]"],
      valid: false,
    },
  ])("$label", ({ role, paths, valid }) => {
    const result = validateAssessment(
      positive(paths.map(path => ["step", path])),
      contract({ step: role }),
      typedAtif(),
    );
    expect(Boolean(result.assessment)).toBe(valid);
  });

  it("explicit min zero and max zero forbids that role", () => {
    const output = contract({
      anchor: step(1, 1),
      forbidden: {
        type: "atif.tool_call",
        description: "Forbidden call.",
        min: 0,
        max: 0,
      },
    });
    expect(validateAssessment(
      positive([["anchor", "$.steps[0]"]]),
      output,
      typedAtif(),
    ).diagnostics).toEqual([]);
    expect(validateAssessment(
      positive([
        ["anchor", "$.steps[0]"],
        ["forbidden", "$.steps[0].tool_calls[0]"],
      ]),
      output,
      typedAtif(),
    ).diagnostics.map(value => value.code)).toContain("role_cardinality");
  });

  it("undeclared roles and canonical duplicate references fail", () => {
    const output = contract({ step: step() });
    expect(validateAssessment(
      positive([["unknown", "$.steps[0]"]]),
      output,
      typedAtif(),
    ).diagnostics.map(value => value.code)).toContain("unknown_role");
    expect(validateAssessment(
      positive([
        ["step", "$.steps[0]"],
        ["step", '$["steps"][0]'],
      ]),
      output,
      typedAtif(),
    ).diagnostics.map(value => value.code)).toContain("duplicate_reference");
  });

  it.each([
    {
      label: "invalid path syntax",
      path: "$.steps[*]",
      code: "invalid_jsonpath",
    },
    {
      label: "unresolved path",
      path: "$.steps[99]",
      code: "unresolved_reference",
    },
    {
      label: "wrong registered type",
      path: "$.steps[0].tool_calls[0]",
      code: "reference_type_mismatch",
    },
  ])("$label", ({ path, code }) => {
    expect(validateAssessment(
      positive([["step", path]]),
      contract({ step: step() }),
      typedAtif(),
    ).diagnostics.map(value => value.code)).toContain(code);
  });

  it("cardinality is isolated per occurrence", () => {
    const result = validateAssessment({
      state: "completed",
      observed: true,
      occurrences: [
        { evidence: [{ role: "step", path: "$.steps[0]" }] },
        {
          evidence: [{
            role: "optional",
            path: "$.steps[0].tool_calls[0]",
          }],
        },
      ],
    }, contract({
      step: step(),
      optional: {
        type: "atif.tool_call",
        description: "Optional call.",
        min: 0,
      },
    }), typedAtif());
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "role_cardinality",
        output_path: "$.occurrences[1].evidence",
        role: "step",
      }),
    ]);
  });
});

describe("evidence role authoring validation", () => {
  function taxonomyDocument(output: unknown) {
    return {
      schema_version: "scope/taxonomy/v1",
      id: "role-probe",
      version: "1.0.0",
      surfaces: [],
      elements: [{
        id: "probe",
        label: "Probe",
        implementation: { type: "prompt", prompt: "Assess." },
        preconditions: {},
        output,
      }],
    };
  }

  async function load(output: unknown) {
    const directory = await mkdtemp(join(tmpdir(), "role-probe-"));
    directories.push(directory);
    const path = join(directory, "taxonomy.yaml");
    await writeFile(path, JSON.stringify(taxonomyDocument(output)));
    return loadTaxonomy(path, { handlers: createHandlerRegistry() });
  }

  it("normalizes omitted min to one and omitted max to unbounded", async () => {
    const loaded = await load({
      evidence_roles: {
        evidence: {
          type: "atif.step",
          description: "Evidence.",
        },
      },
    });
    expect(loaded.elementById.get("probe")?.output.evidence_roles.evidence)
      .toEqual({
        type: "atif.step",
        description: "Evidence.",
        min: 1,
      });
  });

  it.each([
    {
      label: "negative minimum",
      role: { type: "atif.step", description: "Evidence.", min: -1 },
    },
    {
      label: "fractional minimum",
      role: { type: "atif.step", description: "Evidence.", min: 0.5 },
    },
    {
      label: "negative maximum",
      role: {
        type: "atif.step",
        description: "Evidence.",
        min: 0,
        max: -1,
      },
    },
    {
      label: "fractional maximum",
      role: { type: "atif.step", description: "Evidence.", max: 1.5 },
    },
    {
      label: "maximum below minimum",
      role: {
        type: "atif.step",
        description: "Evidence.",
        min: 2,
        max: 1,
      },
    },
    {
      label: "missing description",
      role: { type: "atif.step" },
    },
    {
      label: "empty description",
      role: { type: "atif.step", description: "" },
    },
    {
      label: "unknown type",
      role: { type: "atif.unknown", description: "Evidence." },
    },
    {
      label: "unknown role field",
      role: {
        type: "atif.step",
        description: "Evidence.",
        unexpected: true,
      },
    },
  ])("rejects $label", async ({ role }) => {
    await expect(load({
      evidence_roles: { evidence: role },
    })).rejects.toThrow();
  });

  it("rejects invalid role names and empty role sets", async () => {
    await expect(load({
      evidence_roles: {
        "bad-role": {
          type: "atif.step",
          description: "Evidence.",
        },
      },
    })).rejects.toThrow();
    await expect(load({ evidence_roles: {} })).rejects.toThrow(
      "At least one evidence role is required",
    );
  });

  it("rejects constraints that cite undeclared roles", async () => {
    await expect(load({
      evidence_roles: {
        target: {
          type: "atif.step",
          description: "Target.",
        },
      },
      constraints: [{
        kind: "descendant_of",
        role: "target",
        reference_role: "missing",
      }],
    })).rejects.toThrow("unknown reference role");
  });
});
