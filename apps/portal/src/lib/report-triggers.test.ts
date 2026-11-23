// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { evaluateTrigger, matchingReportTemplates } from "./report-triggers";
import type { ReportTemplate, Run, TaskPrompt } from "@/types";

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    _id: "run-1",
    id: "run-1",
    workerType: "coder-acp-copilot",
    scenario: { task: "do thing", criteria: ["c1", "c2"] },
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Run;
}

function makeTemplate(trigger: ReportTemplate["trigger"], id = "t1"): ReportTemplate {
  return {
    _id: id,
    id,
    name: `Template ${id}`,
    userPrompt: "prompt",
    trigger,
    createdAt: new Date().toISOString(),
  };
}

describe("evaluateTrigger", () => {
  it("returns false when run is missing", () => {
    expect(evaluateTrigger({ type: "always" }, undefined)).toBe(false);
  });

  it("treats missing trigger as always", () => {
    expect(evaluateTrigger(undefined, makeRun())).toBe(true);
  });

  it("matches always trigger", () => {
    expect(evaluateTrigger({ type: "always" }, makeRun())).toBe(true);
  });

  it("matches criteria trigger with any", () => {
    expect(
      evaluateTrigger({ type: "criteria", criteriaIds: ["c2", "x"] }, makeRun()),
    ).toBe(true);
  });

  it("respects criteria match=all", () => {
    expect(
      evaluateTrigger({ type: "criteria", criteriaIds: ["c1", "x"], match: "all" }, makeRun()),
    ).toBe(false);
    expect(
      evaluateTrigger({ type: "criteria", criteriaIds: ["c1", "c2"], match: "all" }, makeRun()),
    ).toBe(true);
  });

  it("matches taskPrompt trigger by id", () => {
    const run = makeRun({ taskPromptId: "tp-1" });
    expect(evaluateTrigger({ type: "taskPrompt", taskPromptIds: ["tp-1"] }, run)).toBe(true);
    expect(evaluateTrigger({ type: "taskPrompt", taskPromptIds: ["tp-2"] }, run)).toBe(false);
  });

  it("matches promptFeature trigger against detected features", () => {
    const taskPrompt: TaskPrompt = {
      _id: "tp",
      id: "tp",
      text: "t",
      createdAt: new Date().toISOString(),
      features: [
        { featureId: "f1", detected: true, evaluated: true },
        { featureId: "f2", detected: false, evaluated: true },
      ],
    } as TaskPrompt;
    expect(
      evaluateTrigger({ type: "promptFeature", featureIds: ["f1"] }, makeRun(), taskPrompt),
    ).toBe(true);
    expect(
      evaluateTrigger({ type: "promptFeature", featureIds: ["f2"] }, makeRun(), taskPrompt),
    ).toBe(false);
  });
});

describe("matchingReportTemplates", () => {
  it("returns only templates whose trigger matches", () => {
    const run = makeRun();
    const templates = [
      makeTemplate({ type: "always" }, "always"),
      makeTemplate({ type: "criteria", criteriaIds: ["nope"] }, "nomatch"),
      makeTemplate({ type: "criteria", criteriaIds: ["c1"] }, "match"),
    ];
    const matched = matchingReportTemplates(templates, run);
    expect(matched.map((t) => t.id)).toEqual(["always", "match"]);
  });

  it("returns empty array when no templates", () => {
    expect(matchingReportTemplates(undefined, makeRun())).toEqual([]);
  });
});
