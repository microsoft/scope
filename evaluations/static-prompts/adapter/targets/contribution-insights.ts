// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { readPolicies, type InsightsContext } from "../../../../scripts/contribution-insights/collect.mjs";
import { parseReport, renderReport, SCENARIOS, type ContributionReport } from "../../../../scripts/contribution-insights/report.mjs";
import type { AdapterContext, AdapterExecution, ComposedPromptRequest, PromptTargetAdapter } from "../protocol.js";
import { record, requiredString } from "../validation.js";

const WORKFLOW = new URL("../../../../.github/workflows/contribution-insights.md", import.meta.url);
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SNAPSHOT_PATH = "/tmp/gh-aw/contribution-insights/context.json";

export async function composeContributionRequest(input: unknown): Promise<{
  request: ComposedPromptRequest;
  snapshot: InsightsContext;
}> {
  const snapshot = await loadContributionSnapshot(record(input).snapshot);
  const source = await readFile(WORKFLOW, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
  if (!match) throw new Error("Contribution workflow must have YAML frontmatter and an instruction body");
  const frontmatter = record(YAML.parse(match[1]) as unknown, "workflow");
  const outputs = record(frontmatter["safe-outputs"], "safe outputs");
  const jobs = record(outputs.jobs, "safe output jobs");
  const job = record(jobs["contribution-report"], "contribution report job");
  const reportInput = record(record(job.inputs, "job inputs").report, "report input");
  const content = JSON.stringify(snapshot);
  return {
    snapshot,
    request: {
      messages: [
        { role: "system", content: match[2] },
        { role: "user", content: `Captured file contents: ${SNAPSHOT_PATH}\nThe file contents are provided inline below; filesystem access is neither available nor necessary.\n<untrusted-contribution-snapshot>\n${content}\n</untrusted-contribution-snapshot>` },
      ],
      files: [{ path: SNAPSHOT_PATH, content, trust: "untrusted" }],
      tools: [{
        name: "contribution_report",
        description: requiredString(job.description, "report tool description"),
        parameters: {
          type: "object", additionalProperties: false, required: ["report"],
          properties: { report: { type: "string", description: requiredString(reportInput.description, "report input description") } },
        },
      }],
      metadata: {
        adapterId: "contribution-insights/default",
        productionSources: [".github/workflows/contribution-insights.md", "scripts/contribution-insights/collect.mts", "scripts/contribution-insights/report.mts"],
        insertionPoint: SNAPSHOT_PATH,
        fidelity: "partial",
      },
    },
  };
}

export async function loadContributionSnapshot(value: unknown): Promise<InsightsContext> {
  const snapshot: InsightsContext = JSON.parse(requiredString(value, "input.snapshot"));
  if (snapshot.schemaVersion !== 1 || snapshot.mode !== "report-only" || !Array.isArray(snapshot.contributions)) {
    throw new Error("input.snapshot must be a version 1 report-only contribution snapshot");
  }
  snapshot.policies = await readPolicies(ROOT);
  return snapshot;
}

export async function executeContributionRequest(
  { request, snapshot }: Awaited<ReturnType<typeof composeContributionRequest>>,
  context: AdapterContext,
): Promise<AdapterExecution<{ report: ContributionReport; markdown: string }>> {
  let submitted: ContributionReport | undefined;
  const completion = await context.complete(request, {
    maxToolRounds: 2,
    async executeTool(name, arguments_) {
      if (name !== "contribution_report") throw new Error(`Unexpected contribution tool: ${name}`);
      if (submitted) throw new Error("Contribution report was submitted more than once");
      const argumentsRecord = record(arguments_, "tool arguments");
      submitted = parseReport(requiredString(argumentsRecord.report, "report"), snapshot);
      return { submitted: true, mode: "report-only" };
    },
  });
  const report = submitted ?? parseReport(completion.content, snapshot);
  return {
    request, rawResponse: completion.content,
    output: { report, markdown: renderReport(report, snapshot) },
    invocationMetadata: completion.metadata,
  };
}

export const contributionInsightsAdapter: PromptTargetAdapter = {
  family: "contribution-insights",
  variants: ["default"],
  async run(input, _variant, context) {
    return executeContributionRequest(await composeContributionRequest(input), context);
  },
};

export function fakeContributionReport(request: ComposedPromptRequest): string {
  const file = request.files?.find((candidate) => candidate.path === SNAPSHOT_PATH);
  if (!file) throw new Error("Fake contribution transport requires the captured snapshot");
  const snapshot: InsightsContext = JSON.parse(file.content);
  const report: ContributionReport = {
    schemaVersion: 2,
    assessments: snapshot.contributions.map((contribution) => ({
      number: contribution.number, headSha: contribution.headSha,
      value: { score: null, rationale: "Offline fake transport does not judge contribution value.", evidence: [] },
      correctnessEvidence: { score: null, rationale: "Offline fake transport does not establish correctness.", evidence: [] },
      readiness: "needs-clarification", risk: contribution.minimumApprovals === 2 ? "high" : "medium",
      confidence: "low",
      scenarios: SCENARIOS.map((id) => ({
        id, assessment: "unassessed", summary: "Offline fake transport; substantive analysis was not performed.", evidence: [],
      })),
      reviewerBrief: {
        summary: "Offline contract fixture only.", reviewOrder: [], suggestedOwners: [], requiredApprovals: contribution.minimumApprovals,
      },
      feedback: { required: [], optional: [], maintainerDecision: [] },
      limitations: ["Offline fake transport verifies composition and output plumbing, not model quality."],
    })),
  };
  return JSON.stringify(report);
}
