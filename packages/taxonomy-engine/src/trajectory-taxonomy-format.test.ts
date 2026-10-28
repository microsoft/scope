// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  canonicalJsonSha256,
  canonicalJsonStringify,
} from "./canonical-json.js";
import {
  parseDefiniteJsonPath,
  validateAssessment,
} from "./evidence.js";
import { createHandlerRegistry } from "./handlers.js";
import { createInputIdentity } from "./input-identity.js";
import {
  parseScopeAtif,
  validateScopeAtif,
} from "./scope-atif.js";
import { loadTaxonomy } from "./taxonomy.js";

const root = fileURLToPath(new URL(
  "../conformance/trajectory-taxonomy-format/",
  import.meta.url,
));

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(`${root}${path}`, "utf8")) as unknown;
}

async function taxonomy() {
  return loadTaxonomy(`${root}valid/taxonomy.yaml`, {
    handlers: createHandlerRegistry(),
  });
}

describe("trajectory taxonomy format conformance", () => {
  it("matches canonical JSON and normalized ATIF fingerprint vectors", async () => {
    const vectors = await json("fingerprints.json") as {
      canonical_json: {
        value: unknown;
        serialized: string;
        sha256: string;
      };
      normalized_atif: { file: string; sha256: string };
    };
    expect(canonicalJsonStringify(vectors.canonical_json.value))
      .toBe(vectors.canonical_json.serialized);
    expect(canonicalJsonSha256(vectors.canonical_json.value))
      .toBe(vectors.canonical_json.sha256);

    const atif = parseScopeAtif(await json(vectors.normalized_atif.file));
    expect(createInputIdentity(atif).sha256)
      .toBe(vectors.normalized_atif.sha256);
    const sameSessionDifferentDocument = parseScopeAtif(
      await json("valid/atif-v17.json"),
    );
    expect(sameSessionDifferentDocument.session_id).toBe(atif.session_id);
    expect(createInputIdentity(sameSessionDifferentDocument).sha256)
      .not.toBe(createInputIdentity(atif).sha256);
  });

  it("parses ATIF v1.7/v1.8 and preserves mixed content with audio aliases", async () => {
    const loaded = await taxonomy();
    const v17 = parseScopeAtif(await json("valid/atif-v17.json"));
    const v18 = parseScopeAtif(await json("valid/atif-v18-mixed-media.json"));
    validateScopeAtif(v17, loaded);
    validateScopeAtif(v18, loaded);

    expect(v17.schema_version).toBe("ATIF-v1.8");
    expect(v18.schema_version).toBe("ATIF-v1.8");
    expect(v18.steps[0].message).toEqual([
      { type: "text", text: "Describe the attached evidence." },
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
          media_type: "audio/mpeg",
          path: "audio/evidence.mp3",
          duration_sec: 1.5,
        },
      },
    ]);
    expect(v18.steps[1].observation?.results[0].content).toEqual([
      { type: "text", text: "Account 42." },
      {
        type: "audio",
        source: {
          media_type: "audio/wav",
          path: "audio/result.wav",
        },
      },
    ]);
  });

  it("rejects malformed media and nonstandard v1.7 observation JSON", () => {
    const base = {
      schema_version: "ATIF-v1.8",
      trajectory_id: "media-validation",
      agent: { name: "fixture", version: "1.0.0" },
      steps: [{
        step_id: 1,
        source: "agent",
        message: "Result.",
        observation: { results: [{ content: [] }] },
      }],
    };
    for (const content of [
      [{
        type: "image",
        source: { media_type: "audio/wav", path: "sound.wav" },
      }],
      [{
        type: "audio",
        source: {
          media_type: "audio/wav",
          path: "sound.wav",
          duration_sec: -1,
        },
      }],
      [{ type: "text", source: { media_type: "image/png", path: "a.png" } }],
      { arbitrary: true },
    ]) {
      expect(() => parseScopeAtif({
        ...base,
        steps: [{
          ...base.steps[0],
          observation: { results: [{ content }] },
        }],
      }), JSON.stringify(content)).toThrow();
    }

    expect(() => parseScopeAtif({
      ...base,
      schema_version: "ATIF-v1.7",
      agent: { name: "fixture", version: "1.0.0" },
      steps: [{
        ...base.steps[0],
        observation: {
          results: [{ content: { legacy: "scope-v1.7-json" } }],
        },
      }],
    })).toThrow();
  });

  it("canonicalizes definite JSONPath aliases and rejects executable/prototype features", async () => {
    expect(parseDefiniteJsonPath("$[\"steps\"][1]['tool_calls'][0]").canonical)
      .toBe("$.steps[1].tool_calls[0]");
    expect(parseDefiniteJsonPath('$["a\\\"b"]').canonical)
      .toBe('$["a\\\"b"]');
    expect(parseDefiniteJsonPath("$['a\\'b']").canonical)
      .toBe('$["a\'b"]');
    expect(parseDefiniteJsonPath(
      parseDefiniteJsonPath('$["a\\\"b"]').canonical,
    ).canonical).toBe('$["a\\\"b"]');
    const invalid = await json("invalid/jsonpath-features.json") as string[];
    for (const path of invalid) {
      expect(() => parseDefiniteJsonPath(path), path).toThrow();
    }
  });

  it("rejects non-I-JSON strings and sparse arrays while sorting UTF-16 keys", () => {
    expect(() => canonicalJsonStringify("\ud800")).toThrow(
      "unpaired surrogate",
    );
    expect(() => canonicalJsonStringify({ "\udc00": true })).toThrow(
      "unpaired surrogate",
    );
    expect(() => canonicalJsonStringify(new Array(1))).toThrow("sparse array");
    expect(canonicalJsonStringify({
      "\ufb33": 6,
      "\u20ac": 4,
      "\r": 1,
      "\ud83d\ude00": 5,
      "\u0080": 2,
      "\u00f6": 3,
    })).toBe(
      "{\"\\r\":1,\"\":2,\"ö\":3,\"€\":4,\"😀\":5,\"דּ\":6}",
    );
    expect(canonicalJsonStringify({
      exponent: 1e30,
      fraction: 0.000001,
      negative_zero: -0,
    })).toBe(
      "{\"exponent\":1e+30,\"fraction\":0.000001,\"negative_zero\":0}",
    );
  });

  it("resolves observation ownership through globally linked cross-step calls", () => {
    const atif = parseScopeAtif({
      schema_version: "ATIF-v1.7",
      trajectory_id: "cross-step-result",
      agent: { name: "fixture", version: "1.0.0" },
      steps: [
        {
          step_id: 1,
          source: "agent",
          message: "Call.",
          tool_calls: [{
            tool_call_id: "call-1",
            function_name: "query",
            arguments: {},
          }],
        },
        {
          step_id: 2,
          source: "system",
          message: "Result delivered later.",
          observation: {
            results: [{
              source_call_id: "call-1",
              content: "done",
            }],
          },
        },
      ],
    });
    const validation = validateAssessment({
      state: "completed",
      observed: true,
      occurrences: [{
        evidence: [
          { role: "call", path: "$.steps[0].tool_calls[0]" },
          { role: "result", path: "$.steps[1].observation.results[0]" },
        ],
      }],
    }, {
      evidence_roles: {
        call: {
          type: "atif.tool_call",
          description: "Call.",
          min: 1,
          max: 1,
        },
        result: {
          type: "atif.observation_result",
          description: "Result.",
          min: 1,
          max: 1,
        },
      },
      constraints: [{
        kind: "owned_by",
        role: "result",
        owner_role: "call",
      }],
    }, atif);
    expect(validation.diagnostics).toEqual([]);

    const missingOwner = validateAssessment({
      state: "completed",
      observed: true,
      occurrences: [{
        evidence: [
          { role: "result", path: "$.steps[1].observation.results[0]" },
        ],
      }],
    }, {
      evidence_roles: {
        call: {
          type: "atif.tool_call",
          description: "Optional owner.",
          min: 0,
          max: 1,
        },
        result: {
          type: "atif.observation_result",
          description: "Owned result.",
          min: 1,
          max: 1,
        },
      },
      constraints: [{
        kind: "owned_by",
        role: "result",
        owner_role: "call",
      }],
    }, atif);
    expect(missingOwner.diagnostics.map(value => value.code))
      .toContain("reference_constraint_mismatch");
  });

  it("applies generic after and descendant constraints by selector structure", () => {
    const atif = parseScopeAtif({
      schema_version: "ATIF-v1.8",
      trajectory_id: "generic-constraints",
      agent: { name: "fixture", version: "1.0.0" },
      steps: Array.from({ length: 11 }, (_, index) => ({
        step_id: index + 1,
        source: index === 0 ? "user" : "agent",
        message: [
          { type: "text", text: `first-${index}` },
          { type: "text", text: `second-${index}` },
          { type: "text", text: `third-${index}` },
        ],
      })),
    });
    const afterContract = {
      evidence_roles: {
        first: {
          type: "atif.content_part" as const,
          description: "Earlier nested node.",
          min: 1,
          max: 1,
        },
        later: {
          type: "atif.content_part" as const,
          description: "Later nested node.",
          min: 1,
          max: 1,
        },
      },
      constraints: [{
        kind: "after" as const,
        role: "later",
        reference_role: "first",
        within: '$["steps"][0]["message"]',
      }],
    };
    const assessment = (
      first: string,
      later: string,
    ) => ({
      state: "completed" as const,
      observed: true as const,
      occurrences: [{
        evidence: [
          { role: "first", path: first },
          { role: "later", path: later },
        ],
      }],
    });
    expect(validateAssessment(
      assessment("$.steps[0].message[0]", "$.steps[0].message[1]"),
      afterContract,
      atif,
    ).diagnostics).toEqual([]);
    expect(validateAssessment({
      state: "completed",
      observed: true,
      occurrences: [{
        evidence: [
          { role: "first", path: "$.steps[0].message[0]" },
          { role: "first", path: "$.steps[0].message[1]" },
          { role: "later", path: "$.steps[0].message[2]" },
        ],
      }],
    }, {
      ...afterContract,
      evidence_roles: {
        ...afterContract.evidence_roles,
        first: {
          ...afterContract.evidence_roles.first,
          max: 2,
        },
      },
    }, atif).diagnostics).toEqual([]);
    expect(validateAssessment({
      state: "completed",
      observed: true,
      occurrences: [{
        evidence: [
          { role: "later", path: "$.steps[0].message[2]" },
        ],
      }],
    }, {
      evidence_roles: {
        first: {
          ...afterContract.evidence_roles.first,
          min: 0,
        },
        later: afterContract.evidence_roles.later,
      },
      constraints: afterContract.constraints,
    }, atif).diagnostics).toEqual([]);
    for (const [first, later, within] of [
      ["$.steps[0].message[0]", "$.steps[0].message[0]", "$.steps[0].message"],
      ["$.steps[0].message[0]", "$.steps[1].message[1]", "$.steps[0].message"],
      ["$.steps[0].message[0]", "$.steps[0].message[1]", "$.missing"],
      ["$.steps[0].message[0]", "$.steps[0].message[1]", "$.steps[0]"],
    ]) {
      expect(validateAssessment(
        assessment(first, later),
        {
          ...afterContract,
          constraints: [{
            ...afterContract.constraints[0],
            within,
          }],
        },
        atif,
      ).diagnostics.map(value => value.code)).toContain(
        "reference_constraint_mismatch",
      );
    }

    const descendantContract = {
      evidence_roles: {
        ancestor: {
          type: "atif.step" as const,
          description: "Possible ancestor.",
          min: 0,
        },
        child: {
          type: "atif.content_part" as const,
          description: "Strict descendant.",
          min: 1,
        },
      },
      constraints: [{
        kind: "descendant_of" as const,
        role: "child",
        reference_role: "ancestor",
      }],
    };
    expect(validateAssessment({
      state: "completed",
      observed: true,
      occurrences: [{
        evidence: [
          { role: "ancestor", path: "$.steps[1]" },
          { role: "ancestor", path: "$.steps[10]" },
          { role: "child", path: "$.steps[10].message[0]" },
        ],
      }],
    }, descendantContract, atif).diagnostics).toEqual([]);
    expect(validateAssessment({
      state: "completed",
      observed: true,
      occurrences: [{
        evidence: [
          { role: "ancestor", path: "$.steps[1]" },
          { role: "child", path: "$.steps[10].message[0]" },
        ],
      }],
    }, descendantContract, atif).diagnostics.map(value => value.code))
      .toContain("reference_constraint_mismatch");
    expect(validateAssessment({
      state: "completed",
      observed: true,
      occurrences: [{
        evidence: [
          { role: "ancestor", path: "$.steps[10]" },
          { role: "child", path: "$.steps[10]" },
        ],
      }],
    }, {
      evidence_roles: {
        ancestor: descendantContract.evidence_roles.ancestor,
        child: {
          type: "atif.step",
          description: "Self is not a descendant.",
          min: 1,
        },
      },
      constraints: descendantContract.constraints,
    }, atif).diagnostics.map(value => value.code))
      .toContain("reference_constraint_mismatch");
    expect(validateAssessment({
      state: "completed",
      observed: true,
      occurrences: [{
        evidence: [
          { role: "child", path: "$.steps[10].message[0]" },
        ],
      }],
    }, descendantContract, atif).diagnostics.map(value => value.code))
      .toContain("reference_constraint_mismatch");
  });

  it("normalizes Scope tool responses into observation results without replacing recorded results", async () => {
    const loaded = await taxonomy();
    const atif = parseScopeAtif({
      schema_version: "ATIF-v1.7",
      trajectory_id: "response-only",
      agent: { name: "fixture", version: "1.0.0" },
      steps: [
        {
          step_id: 1,
          source: "agent",
          message: "Call.",
          tool_calls: [{
            tool_call_id: "call-1",
            function_name: "query",
            arguments: {},
            extra: {
              scope: {
                response: { value: 42 },
              },
            },
          }],
        },
        {
          step_id: 2,
          source: "agent",
          message: "Used 24.",
        },
      ],
    });
    expect(atif.steps[0].observation?.results).toEqual([{
      source_call_id: "call-1",
      content: "{\"value\":42}",
    }]);
    const validation = validateAssessment({
      state: "completed",
      observed: true,
      occurrences: [{
        evidence: [
          {
            role: "returned_content",
            path: "$.steps[0].observation.results[0]",
          },
          { role: "misuse", path: "$.steps[1]" },
        ],
      }],
    }, loaded.elementById.get("content")!.output, atif);
    expect(validation.diagnostics).toEqual([]);
  });

  it("validates positive, negative, indeterminate, inapplicable, and grouped content assessments", async () => {
    const loaded = await taxonomy();
    expect(loaded.elementById.get("malformed")?.output.evidence_roles.call)
      .toMatchObject({ min: 1, max: 1, type: "atif.tool_call" });
    expect(loaded.elementById.get("malformed")?.output.evidence_roles.issue)
      .toMatchObject({ min: 1, type: "scope.input_validation_issue" });
    expect(loaded.elementById.get("content")?.output.constraints)
      .toEqual([{
        kind: "after",
        role: "misuse",
        reference_role: "returned_content",
        within: "$.steps",
      }]);
    const atif = parseScopeAtif(await json("valid/atif-v17.json"));
    for (const file of [
      "valid/positive-assessment.json",
      "valid/content-assessment.json",
      "valid/negative-assessment.json",
      "valid/indeterminate-assessment.json",
      "valid/inapplicable-assessment.json",
    ]) {
      const fixture = await json(file) as {
        element_id: string;
        assessment: unknown;
      };
      const element = loaded.elementById.get(fixture.element_id)!;
      const result = validateAssessment(
        fixture.assessment,
        element.output,
        atif,
      );
      expect(result.diagnostics, file).toEqual([]);
      expect(result.assessment, file).toBeDefined();
    }
  });

  it("returns stable diagnostics for invalid roles, cardinality, paths, types, ownership, and ordering", async () => {
    const loaded = await taxonomy();
    const atif = parseScopeAtif(await json("valid/atif-v17.json"));
    for (const file of [
      "invalid/unknown-role.json",
      "invalid/cardinality.json",
      "invalid/excess-cardinality.json",
      "invalid/duplicate-reference.json",
      "invalid/unresolved-reference.json",
      "invalid/type-mismatch.json",
      "invalid/ownership.json",
      "invalid/descendant.json",
      "invalid/order.json",
    ]) {
      const fixture = await json(file) as {
        expected_code: string;
        element_id: string;
        assessment: unknown;
      };
      const element = loaded.elementById.get(fixture.element_id)!;
      const result = validateAssessment(
        fixture.assessment,
        element.output,
        atif,
      );
      expect(result.assessment, file).toBeUndefined();
      expect(result.diagnostics.map(value => value.code), file)
        .toContain(fixture.expected_code);
    }
    for (const assessment of [
      { state: "completed", observed: false, extra: true },
      { state: "completed", observed: true, occurrences: [] },
      {
        state: "completed",
        observed: true,
        occurrences: [{ evidence: [] }],
      },
      { state: "indeterminate", reason: "" },
      { state: "inapplicable", reason: "N/A", extra: true },
    ]) {
      expect(validateAssessment(
        assessment,
        loaded.elementById.get("malformed")!.output,
        atif,
      ).diagnostics.map(value => value.code)).toContain("schema_mismatch");
    }
  });

  it("rejects obsolete output_schema authoring", async () => {
    await expect(loadTaxonomy(
      `${root}invalid/output-schema-taxonomy.yaml`,
      { handlers: createHandlerRegistry() },
    )).rejects.toThrow("output.evidence_roles");
    await expect(loadTaxonomy(
      `${root}invalid/unknown-type-taxonomy.yaml`,
      { handlers: createHandlerRegistry() },
    )).rejects.toThrow();
    await expect(loadTaxonomy(
      `${root}invalid/role-cardinality-taxonomy.yaml`,
      { handlers: createHandlerRegistry() },
    )).rejects.toThrow("max must be greater than or equal to min");
    await expect(loadTaxonomy(
      `${root}invalid/relationships-taxonomy.yaml`,
      { handlers: createHandlerRegistry() },
    )).rejects.toThrow("output.constraints");
    await expect(loadTaxonomy(
      `${root}invalid/step-after-taxonomy.yaml`,
      { handlers: createHandlerRegistry() },
    )).rejects.toThrow("explicit within");
    await expect(loadTaxonomy(
      `${root}invalid/evidence-taxonomy.yaml`,
      { handlers: createHandlerRegistry() },
    )).rejects.toThrow("author preconditions instead");
    await expect(loadTaxonomy(
      `${root}invalid/precondition-names-taxonomy.yaml`,
      { handlers: createHandlerRegistry() },
    )).rejects.toThrow("requires_complete_trajectory");
  });
});
