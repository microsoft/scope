// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type {
  Assessment,
  EvidenceConstraint,
  EvidenceContract,
  EvidenceRole,
} from "./assessment.js";
import { validateAssessment } from "./evidence.js";
import { createHandlerRegistry } from "./handlers.js";
import {
  parseScopeAtif,
  type ScopeAtif,
} from "./scope-atif.js";
import { loadTaxonomy } from "./taxonomy.js";

const conformance = fileURLToPath(new URL(
  "../conformance/trajectory-taxonomy-format/",
  import.meta.url,
));
const directories: string[] = [];
let atif: ScopeAtif;

beforeAll(async () => {
  atif = parseScopeAtif(JSON.parse(await readFile(
    `${conformance}valid/atif-v17.json`,
    "utf8",
  )) as unknown);
});

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true })
  ));
});

function role(type: EvidenceRole["type"], min = 1): EvidenceRole {
  return { type, min, description: "Acceptance evidence." };
}

function contract(
  evidenceRoles: Record<string, EvidenceRole>,
  constraint: EvidenceConstraint,
): EvidenceContract {
  return {
    evidence_roles: evidenceRoles,
    constraints: [constraint],
  };
}

type EvidencePair = readonly [role: string, path: string];
type EvidencePairs = readonly EvidencePair[];

function pairs(...references: EvidencePair[]): EvidencePairs {
  return references;
}

function assessment(
  references: EvidencePairs,
): Assessment {
  return {
    state: "completed",
    observed: true,
    occurrences: [{
      evidence: references.map(([evidenceRole, path]) => ({
        role: evidenceRole,
        path,
      })),
    }],
  };
}

function expectValidity(
  output: EvidenceContract,
  references: EvidencePairs,
  valid: boolean,
  input = atif,
) {
  const result = validateAssessment(assessment(references), output, input);
  expect(
    Boolean(result.assessment),
    JSON.stringify(result.diagnostics),
  ).toBe(valid);
  if (!valid) {
    expect(result.assessment).toBeUndefined();
    expect(result.diagnostics.map(value => value.code))
      .toContain("reference_constraint_mismatch");
  }
}

const call0 = "$.steps[1].tool_calls[0]";
const call1 = "$.steps[1].tool_calls[1]";
const issue = (index: number) =>
  `$.steps[1].tool_calls[${index}].extra.scope.input_validation.issues[0]`;
const callRoles = {
  later: role("atif.tool_call"),
  earlier: role("atif.tool_call"),
};
const callOrder: EvidenceConstraint = {
  kind: "after",
  role: "later",
  reference_role: "earlier",
  within: "$.steps[1].tool_calls",
};
const orderedCalls: EvidencePairs = [
  ["later", call1],
  ["earlier", call0],
];

describe("after constraint acceptance matrix", () => {
  it.each([
    {
      label: "nested tool-call array order is independent of owning step",
      constraint: callOrder,
      references: orderedCalls,
      valid: true,
    },
    {
      label: "equal immediate array positions are not strictly after",
      constraint: callOrder,
      references: pairs(["later", call0], ["earlier", call0]),
      valid: false,
    },
    {
      label: "reversed immediate array order is rejected",
      constraint: callOrder,
      references: pairs(["later", call0], ["earlier", call1]),
      valid: false,
    },
    {
      label: "same ATIF step does not acquire object-member order",
      constraint: { ...callOrder, within: "$.steps" },
      references: orderedCalls,
      valid: false,
    },
    {
      label: "canonical-equivalent quoted array selector",
      constraint: {
        ...callOrder,
        within: '$["steps"][1]["tool_calls"]',
      },
      references: pairs(
        ["later", '$["steps"][1]["tool_calls"][1]'],
        ["earlier", call0],
      ),
      valid: true,
    },
    {
      label: "missing array axis fails explicitly",
      constraint: { ...callOrder, within: "$.missing" },
      references: orderedCalls,
      valid: false,
    },
    {
      label: "object-valued axis is rejected",
      constraint: { ...callOrder, within: "$.steps[1]" },
      references: orderedCalls,
      valid: false,
    },
    {
      label: "root object is not an array axis",
      constraint: { ...callOrder, within: "$" },
      references: orderedCalls,
      valid: false,
    },
    {
      label: "references outside an existing axis are rejected",
      constraint: {
        ...callOrder,
        within: "$.steps[1].observation.results",
      },
      references: orderedCalls,
      valid: false,
    },
  ])("$label", ({ constraint, references, valid }) => {
    expectValidity(contract(callRoles, constraint), references, valid);
  });

  it.each([
    {
      label: "after uses all target-reference pairs",
      references: pairs(
        ["later", "$.steps[1].tool_calls[9]"],
        ["later", "$.steps[1].tool_calls[10]"],
        ["earlier", call0],
        ["earlier", call1],
      ),
      valid: true,
    },
    {
      label: "one non-later pair invalidates multi-reference ordering",
      references: pairs(
        ["later", call1],
        ["earlier", call0],
        ["earlier", call1],
      ),
      valid: false,
    },
  ])("$label", ({ references, valid }) => {
    const manyRaw = structuredClone(atif);
    manyRaw.steps[1].tool_calls = Array.from({ length: 11 }, (_, index) => ({
      ...structuredClone(atif.steps[1].tool_calls![0]),
      tool_call_id: `call-${index}`,
    }));
    expectValidity(
      contract(callRoles, callOrder),
      references,
      valid,
      parseScopeAtif(manyRaw),
    );
  });

  it("optional absent after target is vacuously satisfied", () => {
    expectValidity(contract({
      later: role("atif.tool_call", 0),
      earlier: role("atif.tool_call"),
    }, callOrder), [["earlier", call0]], true);
  });

  it("optional absent after reference is vacuously satisfied", () => {
    expectValidity(contract({
      later: role("atif.tool_call"),
      earlier: role("atif.tool_call", 0),
    }, callOrder), [["later", call1]], true);
  });

  it("after references cannot leak across occurrences", () => {
    const result = validateAssessment({
      state: "completed",
      observed: true,
      occurrences: [
        {
          evidence: [
            { role: "later", path: call1 },
            { role: "earlier", path: call0 },
          ],
        },
        {
          evidence: [
            { role: "later", path: call0 },
          ],
        },
      ],
    }, contract({
      later: role("atif.tool_call"),
      earlier: role("atif.tool_call", 0),
    }, callOrder), atif);
    expect(result.assessment).toBeDefined();
    expect(result.diagnostics).toEqual([]);
  });

  it("after failures identify only the invalid occurrence", () => {
    const result = validateAssessment({
      state: "completed",
      observed: true,
      occurrences: [
        {
          evidence: [
            { role: "later", path: call1 },
            { role: "earlier", path: call0 },
          ],
        },
        {
          evidence: [
            { role: "later", path: call0 },
            { role: "earlier", path: call1 },
          ],
        },
      ],
    }, contract(callRoles, callOrder), atif);
    expect(result.assessment).toBeUndefined();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "reference_constraint_mismatch",
        output_path: "$.occurrences[1].evidence",
      }),
    ]);
  });
});

describe("descendant_of constraint acceptance matrix", () => {
  const descendant: EvidenceConstraint = {
    kind: "descendant_of",
    role: "issue",
    reference_role: "call",
  };
  const issueRoles = {
    issue: role("scope.input_validation_issue"),
    call: role("atif.tool_call"),
  };

  it.each([
    {
      label: "validation issue is structurally below its cited call",
      references: pairs(["issue", issue(0)], ["call", call0]),
      valid: true,
    },
    {
      label: "sibling tool call is not a structural ancestor",
      references: pairs(["issue", issue(0)], ["call", call1]),
      valid: false,
    },
    {
      label: "each descendant may match a different cited ancestor",
      references: pairs(
        ["issue", issue(0)],
        ["issue", issue(1)],
        ["call", call0],
        ["call", call1],
      ),
      valid: true,
    },
    {
      label: "every descendant needs a matching ancestor",
      references: pairs(
        ["issue", issue(0)],
        ["issue", issue(1)],
        ["call", call0],
      ),
      valid: false,
    },
    {
      label: "canonical-equivalent ancestor selectors resolve structurally",
      references: pairs(
        ["issue", issue(0)],
        ["call", '$["steps"][1]["tool_calls"][0]'],
      ),
      valid: true,
    },
  ])("$label", ({ references, valid }) => {
    expectValidity(contract(issueRoles, descendant), references, valid);
  });

  it("a node is not its own strict descendant", () => {
    expectValidity(contract({
      child: role("atif.tool_call"),
      parent: role("atif.tool_call"),
    }, {
      kind: "descendant_of",
      role: "child",
      reference_role: "parent",
    }), [["child", call0], ["parent", call0]], false);
  });

  it("optional absent descendant is vacuously satisfied", () => {
    expectValidity(contract({
      ...issueRoles,
      issue: role("scope.input_validation_issue", 0),
    }, descendant), [["call", call0]], true);
  });

  it("present descendant cannot match an absent optional ancestor", () => {
    expectValidity(contract({
      ...issueRoles,
      call: role("atif.tool_call", 0),
    }, descendant), [["issue", issue(0)]], false);
  });

  it("indices one and ten remain distinct ancestry locations", () => {
    const manyRaw = structuredClone(atif);
    manyRaw.steps[1].tool_calls = Array.from({ length: 11 }, (_, index) => ({
      ...structuredClone(atif.steps[1].tool_calls![0]),
      tool_call_id: `call-${index}`,
    }));
    expectValidity(
      contract(issueRoles, descendant),
      [["issue", issue(10)], ["call", call1]],
      false,
      parseScopeAtif(manyRaw),
    );
  });

  it("descendant constraints are isolated per occurrence", () => {
    const result = validateAssessment({
      state: "completed",
      observed: true,
      occurrences: [
        {
          evidence: [
            { role: "issue", path: issue(1) },
            { role: "call", path: call1 },
          ],
        },
        {
          evidence: [
            { role: "issue", path: issue(1) },
            { role: "call", path: call0 },
          ],
        },
      ],
    }, contract(issueRoles, descendant), atif);
    expect(result.assessment).toBeUndefined();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "reference_constraint_mismatch",
        output_path: "$.occurrences[1].evidence",
      }),
    ]);
  });
});

describe("owned_by constraint acceptance matrix", () => {
  const resultRoles = {
    result: role("atif.observation_result"),
    call: role("atif.tool_call"),
  };
  const ownedBy: EvidenceConstraint = {
    kind: "owned_by",
    role: "result",
    owner_role: "call",
  };

  function crossStepInput() {
    const raw = structuredClone(atif);
    raw.steps[2].observation = structuredClone(raw.steps[1].observation);
    delete raw.steps[1].observation;
    return parseScopeAtif(raw);
  }

  function multipleResultInput() {
    const raw = structuredClone(atif);
    raw.steps[1].observation!.results.push({
      source_call_id: raw.steps[1].tool_calls![1].tool_call_id,
      content: "second result",
    });
    return parseScopeAtif(raw);
  }

  it.each([
    {
      label: "same-step source_call_id ownership is accepted",
      input: () => atif,
      references: pairs(
        ["result", "$.steps[1].observation.results[0]"],
        ["call", call0],
      ),
      valid: true,
    },
    {
      label: "cross-step source_call_id ownership is accepted",
      input: crossStepInput,
      references: pairs(
        ["result", "$.steps[2].observation.results[0]"],
        ["call", call0],
      ),
      valid: true,
    },
    {
      label: "wrong cited call is rejected",
      input: crossStepInput,
      references: pairs(
        ["result", "$.steps[2].observation.results[0]"],
        ["call", call1],
      ),
      valid: false,
    },
    {
      label: "present result cannot match absent optional owner",
      input: crossStepInput,
      references: pairs(["result", "$.steps[2].observation.results[0]"]),
      valid: false,
      optionalOwner: true,
    },
  ])("$label", ({ input, references, valid, optionalOwner }) => {
    expectValidity(contract({
      ...resultRoles,
      ...(optionalOwner ? { call: role("atif.tool_call", 0) } : {}),
    }, ownedBy), references, valid, input());
  });

  it("optional absent target is vacuously satisfied", () => {
    expectValidity(contract({
      ...resultRoles,
      result: role("atif.observation_result", 0),
    }, ownedBy), [["call", call0]], true);
  });

  it("semantic ownership does not imply structural containment", () => {
    const input = crossStepInput();
    const references: Array<[string, string]> = [
      ["result", "$.steps[2].observation.results[0]"],
      ["call", call0],
    ];
    expectValidity(contract(resultRoles, ownedBy), references, true, input);
    expectValidity(contract(resultRoles, {
      kind: "descendant_of",
      role: "result",
      reference_role: "call",
    }), references, false, input);
  });

  it("multiple targets can match distributed cited owners", () => {
    const input = multipleResultInput();
    expectValidity(contract(resultRoles, ownedBy), [
      ["result", "$.steps[1].observation.results[0]"],
      ["result", "$.steps[1].observation.results[1]"],
      ["call", call0],
      ["call", call1],
    ], true, input);
  });

  it("one target without its cited owner invalidates multiple ownerships", () => {
    const input = multipleResultInput();
    expectValidity(contract(resultRoles, ownedBy), [
      ["result", "$.steps[1].observation.results[0]"],
      ["result", "$.steps[1].observation.results[1]"],
      ["call", call0],
    ], false, input);
  });

  it.each([
    {
      label: "missing source_call_id cannot satisfy semantic ownership",
      sourceCallId: undefined,
    },
    {
      label: "unknown source_call_id cannot satisfy semantic ownership",
      sourceCallId: "unknown-call",
    },
  ])("$label", ({ sourceCallId }) => {
    const raw = structuredClone(atif);
    if (sourceCallId === undefined) {
      delete raw.steps[1].observation!.results[0].source_call_id;
    } else {
      raw.steps[1].observation!.results[0].source_call_id = sourceCallId;
    }
    const input = sourceCallId === undefined ? parseScopeAtif(raw) : raw;
    expectValidity(contract(resultRoles, ownedBy), [
      ["result", "$.steps[1].observation.results[0]"],
      ["call", call0],
    ], false, input);
  });

  it("owned_by constraints are isolated per occurrence", () => {
    const input = multipleResultInput();
    const result = validateAssessment({
      state: "completed",
      observed: true,
      occurrences: [
        {
          evidence: [
            {
              role: "result",
              path: "$.steps[1].observation.results[1]",
            },
            { role: "call", path: call1 },
          ],
        },
        {
          evidence: [
            {
              role: "result",
              path: "$.steps[1].observation.results[1]",
            },
            { role: "call", path: call0 },
          ],
        },
      ],
    }, contract(resultRoles, ownedBy), input);
    expect(result.assessment).toBeUndefined();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "reference_constraint_mismatch",
        output_path: "$.occurrences[1].evidence",
      }),
    ]);
  });
});

describe("constraint authoring and digest acceptance matrix", () => {
  function taxonomyDocument(output: unknown) {
    return {
      schema_version: "scope/taxonomy/v1",
      id: "constraint-probe",
      version: "1.0.0",
      surfaces: [],
      elements: [{
        id: "probe",
        label: "Probe",
        implementation: {
          type: "prompt",
          prompt: "Return a grounded assessment.",
        },
        preconditions: {},
        output,
      }],
    };
  }

  async function load(output: unknown) {
    const directory = await mkdtemp(join(tmpdir(), "constraint-probe-"));
    directories.push(directory);
    const path = join(directory, "taxonomy.yaml");
    await writeFile(path, JSON.stringify(taxonomyDocument(output)));
    return loadTaxonomy(path, { handlers: createHandlerRegistry() });
  }

  it("canonical-equivalent ordering axes have equal digests", async () => {
    const first = await load(contract(callRoles, callOrder));
    const equivalent = await load(contract(callRoles, {
      ...callOrder,
      within: '$["steps"][1]["tool_calls"]',
    }));
    expect(first.digest).toBe(equivalent.digest);
  });

  it("changed ordering axis changes the contract digest", async () => {
    const first = await load(contract(callRoles, callOrder));
    const changed = await load(contract(callRoles, {
      ...callOrder,
      within: "$.steps",
    }));
    expect(first.digest).not.toBe(changed.digest);
  });

  it("obsolete relationships authoring is rejected", async () => {
    await expect(load({
      evidence_roles: callRoles,
      relationships: [{
        kind: "step_after",
        role: "later",
        reference_role: "earlier",
      }],
    })).rejects.toThrow("output.constraints");
  });

  it("obsolete step_after constraint is rejected", async () => {
    await expect(load({
      evidence_roles: callRoles,
      constraints: [{
        kind: "step_after",
        role: "later",
        reference_role: "earlier",
      }],
    })).rejects.toThrow("explicit within");
  });

  it.each([
    "$.steps[*]",
    "$..tool_calls",
    "$.steps[01]",
    "$.steps[-1]",
    "$.__proto__",
  ])("restricted array-axis syntax rejects %s", async within => {
    await expect(load(contract(callRoles, {
      ...callOrder,
      within,
    }))).rejects.toThrow("invalid within JSONPath");
  });

  it("constraints cannot reference undeclared roles", async () => {
    await expect(load(contract(callRoles, {
      ...callOrder,
      reference_role: "undeclared",
    }))).rejects.toThrow("unknown reference role");
  });

  it("arbitrary executable constraint fields are rejected", async () => {
    await expect(load({
      evidence_roles: callRoles,
      constraints: [{
        ...callOrder,
        script: "return true",
      }],
    })).rejects.toThrow();
  });
});
