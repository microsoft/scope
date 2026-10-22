// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { FULL_SHARE_CONTENT, SharedRunSchema, SUMMARY_SHARE_CONTENT } from "shared/run-sharing";
import { projectSharedRun } from "./projection.js";
import { makeRequest, makeShare } from "./test-fixtures.js";

describe("public run projection", () => {
  it("allowlists Summary recursively rather than returning private run documents", () => {
    const request = makeRequest();
    const view = projectSharedRun(makeShare(), request, request.run!);
    expect(SharedRunSchema.parse(view)).toEqual(JSON.parse(JSON.stringify(view)));
    expect(JSON.stringify(view)).not.toContain("PRIVATE_");
    expect(JSON.stringify(view)).not.toMatch(/tokenHash|createdBy|storage\.example|snapshotUrl|request-1|project-1|attempt-1/);
    expect(view.run.turns[0].criteriaResults).toEqual([{ criterionId: "criterion-1", passed: true, evaluated: true }]);
    expect(view.run.durationMs).toBe(1000);
    expect(view.artifacts).toEqual([]);
    expect(view.prompts).toBeUndefined();
  });

  it.each(Object.keys(SUMMARY_SHARE_CONTENT))("enforces an independently selected %s category", (key) => {
    const request = makeRequest();
    const share = makeShare({ content: { ...SUMMARY_SHARE_CONTENT, [key]: true } });
    const view = projectSharedRun(share, request, request.run!, [{ label: "Task", text: request.scenario.task }]);
    expect(view.prompts !== undefined).toBe(key === "prompts");
    expect(view.run.error !== undefined).toBe(key === "evaluationDetails");
    expect(view.run.turns[0].criteriaResults[0].feedback !== undefined).toBe(key === "evaluationDetails");
    expect(view.run.turns[0].codingAgentResponse !== undefined).toBe(key === "conversations");
    expect(view.run.turns[0].toolCalls).toBeUndefined();
    expect(view.artifacts.every((artifact) => artifact.category === key)).toBe(true);
    expect(JSON.stringify(view)).not.toContain("storage.example");
  });

  it("includes raw transcripts/tool calls only when their dependent categories are also shared", () => {
    const request = makeRequest();
    const share = makeShare({ content: { ...FULL_SHARE_CONTENT } });
    const view = projectSharedRun(share, request, request.run!);
    expect(view.run.turns[0].toolCalls?.[0].name).toBe("PRIVATE_TOOL");
    expect(view.artifacts.some((artifact) => artifact.id === "conversation")).toBe(true);
    expect(view.artifacts.some((artifact) => artifact.category === "network")).toBe(false);
    expect(view.artifacts.some((artifact) => artifact.category === "video")).toBe(false);
    expect(view.artifacts.some((artifact) => artifact.category === "snapshots")).toBe(false);
  });
});
