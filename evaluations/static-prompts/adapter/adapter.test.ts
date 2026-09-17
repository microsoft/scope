// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { REPORT_SYSTEM_PROMPT } from "../../../packages/shared/src/index.js";
import {
  buildCriteriaAuthoringRequest,
  buildCriteriaDependencySuggestionRequest,
  selectCriteriaDependencyPool,
  type ExistingCriterion,
} from "../../../apps/api/src/llm.js";
import {
  buildTaskPromptRequest,
} from "../../../apps/api/src/task-prompt-llm.js";
import {
  buildPromptFeatureExtractionRequest,
} from "../../../apps/api/src/prompt-feature-llm.js";
import {
  QUALITY_FAMILIES,
  RED_TEAM_SURFACES,
  type AdapterContext,
  type ComposedPromptRequest,
} from "./protocol.js";
import {
  getPromptTarget,
  listPromptTargets,
  listRedTeamTargets,
  listTargets,
} from "./registry.js";
import { composeRedTeamSurface } from "./red-team.js";

function fakeContext(
  responder: (request: ComposedPromptRequest) => string,
): AdapterContext {
  return {
    model: "test-model",
    async complete(request) {
      return {
        content: responder(request),
        metadata: { transport: "fake" },
      };
    },
  };
}

describe("static prompt adapter registry", () => {
  it("registers all ten approved prompt families and their variants", () => {
    expect(listPromptTargets()).toEqual([
      { family: "criteria-authoring", variants: ["default"] },
      {
        family: "parent-dependency-suggestion",
        variants: ["default"],
      },
      {
        family: "child-dependency-suggestion",
        variants: ["default"],
      },
      { family: "task-prompt-generation", variants: ["default"] },
      { family: "task-prompt-variation", variants: ["default"] },
      { family: "prompt-feature-authoring", variants: ["default"] },
      { family: "prompt-feature-extraction", variants: ["default"] },
      {
        family: "judge-instructions",
        variants: ["bundled", "independent"],
      },
      {
        family: "developer-feedback",
        variants: ["default", "persona", "descendant-guard"],
      },
      {
        family: "run-report",
        variants: ["default", "append", "override-control"],
      },
    ]);
    expect(listPromptTargets().map(({ family }) => family)).toEqual([
      ...QUALITY_FAMILIES,
    ]);
  });

  it("rejects an unsupported family variant", () => {
    expect(() =>
      getPromptTarget("judge-instructions", "unsupported"),
    ).toThrow("Unsupported variant");
  });

  it("exports a flat machine-readable family/variant registry", () => {
    const targets = listTargets();
    expect(new Set(targets.map(({ family }) => family))).toEqual(
      new Set(QUALITY_FAMILIES),
    );
    expect(targets).toContainEqual({
      adapterId: "judge-instructions/bundled",
      family: "judge-instructions",
      variant: "bundled",
    });
    expect(targets).toContainEqual({
      adapterId: "run-report/override-control",
      family: "run-report",
      variant: "override-control",
    });
    expect(listRedTeamTargets().map(({ surface }) => surface)).toEqual([
      ...RED_TEAM_SURFACES,
    ]);
    expect(JSON.parse(JSON.stringify(targets))).toEqual(targets);
  });
});

describe("API prompt production contracts", () => {
  it("uses the production criterion authoring builder and parser", async () => {
    const input = {
      behavior: "The project builds",
      gates: ["build"],
      existingCriteria: [],
    };
    const result = await getPromptTarget("criteria-authoring").run(
      input,
      "default",
      fakeContext(() =>
        JSON.stringify({
          prompt: "Use captured build output.",
          suggestedId: "Builds Cleanly!",
        }),
      ),
    );

    const production = buildCriteriaAuthoringRequest(
      input.behavior,
      ["build"],
      "test-model",
    );
    expect(result.request.messages).toEqual(production.messages);
    expect(result.output).toEqual({
      prompt: "Use captured build output.",
      suggestedId: "builds_cleanly",
    });
  });

  it.each([
    ["parent-dependency-suggestion", "parents"],
    ["child-dependency-suggestion", "children"],
  ] as const)("uses the production %s composition", async (family, direction) => {
    const input: {
      behavior: string;
      existingCriteria: ExistingCriterion[];
      gates: ["select"];
    } = {
      behavior: "Has unit tests",
      existingCriteria: [
        {
          id: "has_tests",
          prompt: "Tests exist.",
          gates: ["select"],
        },
        {
          id: "builds",
          prompt: "Build succeeds.",
          gates: ["build"],
        },
      ],
      gates: ["select"],
    };
    const adapter = getPromptTarget(family);
    const result = await adapter.run(
      input,
      "default",
      fakeContext(() => '{"suggestions":["has_tests","not_supplied"]}'),
    );
    const pool = selectCriteriaDependencyPool(
      direction,
      input.existingCriteria,
      ["select"],
    );
    const production = buildCriteriaDependencySuggestionRequest(
      direction,
      input.behavior,
      pool,
      "test-model",
    );
    expect(result.request.messages).toEqual(production.messages);
    expect(result.output).toEqual(["has_tests"]);
  });

  it.each([
    [
      "task-prompt-generation",
      { description: "Build a CLI", existingPrompts: ["Build an API"] },
    ],
    [
      "task-prompt-variation",
      {
        description: "Use Go",
        existingPrompt: "Build a CSV CLI",
        existingPrompts: [],
      },
    ],
  ] as const)("uses production task composition for %s", async (family, input) => {
    const result = await getPromptTarget(family).run(
      input,
      "default",
      fakeContext(() => '{"taskPrompt":"Build the requested project."}'),
    );
    const production = buildTaskPromptRequest(
      {
        description: input.description,
        ...("existingPrompt" in input
          ? { existingPrompt: input.existingPrompt }
          : {}),
      },
      [...input.existingPrompts],
      "test-model",
    );
    expect(result.request.messages).toEqual(production.messages);
    expect(result.output).toEqual({
      taskPrompt: "Build the requested project.",
    });
  });

  it("normalizes prompt-feature extraction through the production parser", async () => {
    const input = {
      taskText: "Build a tested HTTP API.",
      features: [
        { id: "asks_for_api", prompt: "The task asks for an API." },
        { id: "asks_for_tests", prompt: "The task asks for tests." },
      ],
    };
    const result = await getPromptTarget("prompt-feature-extraction").run(
      input,
      "default",
      fakeContext(() =>
        JSON.stringify({
          results: [{ featureId: "asks_for_api", detected: true }],
          suggestedFeatures: [],
        }),
      ),
    );
    const production = buildPromptFeatureExtractionRequest(
      input.taskText,
      input.features,
      "test-model",
    );
    expect(result.request.messages).toEqual(production.messages);
    expect(result.output).toEqual({
      results: [
        {
          featureId: "asks_for_api",
          detected: true,
          evaluated: true,
        },
        {
          featureId: "asks_for_tests",
          detected: false,
          evaluated: false,
        },
      ],
      suggestedFeatures: [],
    });
  });

  it("runs prompt-feature authoring through production composition and parsing", async () => {
    const result = await getPromptTarget("prompt-feature-authoring").run(
      {
        behavior: "The task requests tests.",
        existingFeatures: [
          {
            id: "asks_for_quality",
            prompt: "The task requests quality checks.",
          },
        ],
      },
      "default",
      fakeContext(() =>
        JSON.stringify({
          prompt: "The task asks for automated tests.",
          suggestedId: "Asks For Tests!",
          suggestedParents: ["asks_for_quality", "unknown"],
          suggestedChildren: [],
        }),
      ),
    );
    expect(result.output).toEqual({
      prompt: "The task asks for automated tests.",
      suggestedId: "asks_for_tests",
      suggestedParents: ["asks_for_quality"],
      suggestedChildren: [],
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});

describe("session prompt adapters", () => {
  const judgeInput = {
    criteria: [{ id: "has_readme", prompt: "A README exists." }],
    workspaceFiles: { "README.md": "# Example" },
    conversationHistory: [],
    iterationToolCalls: [],
    currentAgentResponse: "Implemented the requested documentation.",
  };

  it("captures bundled and independent judge requests with real tool definitions", async () => {
    const bundled = await getPromptTarget("judge-instructions", "bundled").run(
      judgeInput,
      "bundled",
      fakeContext(() =>
        '{"results":[{"criterion":"has_readme","passed":true,"feedback":"Found it."}]}',
      ),
    );
    const independent = await getPromptTarget(
      "judge-instructions",
      "independent",
    ).run(
      judgeInput,
      "independent",
      fakeContext(() => "PASS:\nFound it."),
    );

    expect(bundled.request.messages[1].content).toContain("has_readme");
    expect(independent.request.messages[1].content).toContain("has_readme");
    expect(bundled.request.messages[0].content).not.toContain(
      "A README exists.",
    );
    expect(independent.request.messages[0].content).not.toContain(
      "A README exists.",
    );
    expect(independent.request.tools?.map((tool) => tool.name)).toContain(
      "read_agent_response",
    );
    expect(independent.request.files).toEqual([
      {
        path: "README.md",
        content: "# Example",
        trust: "untrusted",
      },
    ]);
    expect(bundled.output).toMatchObject({
      allPassed: true,
      strategy: "bundled",
    });
    expect(independent.output).toMatchObject({
      allPassed: true,
      strategy: "independent",
    });
  });

  it("composes feedback with persona and descendant guard through production", async () => {
    const result = await getPromptTarget(
      "developer-feedback",
      "descendant-guard",
    ).run(
      {
        criteria: [
          { id: "base", prompt: "Create the project." },
          {
            id: "child",
            prompt: "Add hidden advanced behavior.",
            dependsOn: ["base"],
          },
        ],
        judgeResults: [
          {
            criterionId: "base",
            passed: false,
            evaluated: true,
            feedback: "The project is missing.",
          },
        ],
        personaInstructions: "Be terse and direct.",
        includeDescendantGuard: true,
      },
      "descendant-guard",
      fakeContext(() => "Create the missing project."),
    );

    expect(result.request.messages[0].content).toContain(
      "Be terse and direct.",
    );
    expect(result.request.messages[0].content).toContain(
      "Add hidden advanced behavior.",
    );
    expect(result.output).toEqual({
      feedback: "Create the missing project.",
      selectedCriteriaIds: ["base"],
    });
  });

  it.each([
    ["default", undefined],
    ["append", "Additional trusted instructions."],
    ["override-control", "Replacement instructions."],
  ] as const)("resolves report %s composition and production tools", async (
    variant,
    systemPromptContent,
  ) => {
    const result = await getPromptTarget("run-report", variant).run(
      {
        requestId: "request-123",
        reportId: "report-123",
        userPrompt: "Analyze {{requestId}}.",
        ...(systemPromptContent ? { systemPromptContent } : {}),
      },
      variant,
      fakeContext(() => "# Report"),
    );

    expect(result.request.messages[1].content).toBe(
      "Analyze request-123.",
    );
    if (variant === "default") {
      expect(result.request.messages[0].content).toBe(REPORT_SYSTEM_PROMPT);
    } else if (variant === "append") {
      expect(result.request.messages[0].content).toBe(
        `${REPORT_SYSTEM_PROMPT}\n\n${systemPromptContent}`,
      );
    } else {
      expect(result.request.messages[0].content).toBe(systemPromptContent);
      expect(result.request.messages[0].content).not.toBe(
        REPORT_SYSTEM_PROMPT,
      );
    }
    expect(result.request.tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "get_run_summary",
        "list_turns",
        "get_turn_detail",
        "get_criteria_trajectory",
        "search_insights",
        "create_insight",
        "reference_insight",
      ]),
    );
  });
});

describe("red-team composed request surfaces", () => {
  const inputs: Record<(typeof RED_TEAM_SURFACES)[number], unknown> = {
    "task-scenario-prompt": {},
    "gate-prompt": {},
    "agents-md": { taskPrompt: "Build the project." },
    "criterion-prompt": {},
    "prompt-feature-definition": {
      taskText: "Build a web API.",
      featureId: "asks_for_api",
    },
    "persona-instructions": {
      criteria: [{ id: "base", prompt: "Create the project." }],
      judgeResults: [
        {
          criterionId: "base",
          passed: false,
          evaluated: true,
          feedback: "Missing project.",
        },
      ],
    },
    "report-user-prompt": { requestId: "request-1" },
    "report-system-prompt": {
      requestId: "request-1",
      userPrompt: "Analyze {requestId}.",
      systemPromptMode: "append",
    },
  };

  it("composes all eight surfaces with stable fingerprints", async () => {
    for (const surface of RED_TEAM_SURFACES) {
      const first = await composeRedTeamSurface(
        surface,
        "ATTACK_PAYLOAD",
        inputs[surface],
        "test-model",
      );
      const second = await composeRedTeamSurface(
        surface,
        "ATTACK_PAYLOAD",
        inputs[surface],
        "test-model",
      );
      expect(first.surface).toBe(surface);
      expect(first.compositionFingerprint).toBe(
        second.compositionFingerprint,
      );
      expect(JSON.stringify(first.request)).toContain("ATTACK_PAYLOAD");
      expect(first.request.metadata.productionSources.length).toBeGreaterThan(
        0,
      );
      expect(JSON.parse(JSON.stringify(first))).toEqual(first);

      switch (surface) {
        case "task-scenario-prompt":
        case "gate-prompt":
          expect(first.request.messages).toEqual([
            { role: "user", content: "ATTACK_PAYLOAD" },
          ]);
          break;
        case "agents-md":
          expect(first.request.files).toEqual([
            {
              path: "AGENTS.md",
              content: "ATTACK_PAYLOAD",
              trust: "untrusted",
            },
          ]);
          expect(first.request.metadata.fidelity).toBe("partial");
          break;
        case "criterion-prompt":
        case "prompt-feature-definition":
          expect(first.request.messages[0].content).not.toContain(
            "ATTACK_PAYLOAD",
          );
          expect(first.request.messages[1].content).toContain(
            "ATTACK_PAYLOAD",
          );
          break;
        case "persona-instructions":
        case "report-system-prompt":
          expect(first.request.messages[0].content).toContain(
            "ATTACK_PAYLOAD",
          );
          break;
        case "report-user-prompt":
          expect(first.request.messages[1].content).toContain(
            "ATTACK_PAYLOAD",
          );
          expect(first.request.messages[0].content).not.toContain(
            "ATTACK_PAYLOAD",
          );
          break;
      }
    }
  });
});
