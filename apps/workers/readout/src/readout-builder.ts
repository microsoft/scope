// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import {
  EXPERIMENT_READOUT_SCHEMA_ID,
  EXPERIMENT_READOUT_SCHEMA_VERSION,
  experimentReadoutSchema,
  type CriteriaDocument,
  type CriterionResult,
  type ExperimentReadout,
  type RequestDocument,
  type RunState,
} from "shared";

export interface ExactRunEvidence {
  request: RequestDocument;
  run: RunState;
  criteria: CriteriaDocument[];
  trajectories: Array<{ iteration: number; trajectory: unknown }>;
}

export interface ExperimentEvidence {
  experimentId: string;
  experimentExecutionId: string;
  runs: ExactRunEvidence[];
}

const evidenceReferenceSchema = z.object({
  requestId: z.string().min(1),
  runId: z.string().min(1),
  iteration: z.number().int().min(0).optional(),
  criterionId: z.string().min(1).optional(),
  excerpt: z.string().min(1),
});

export const readoutSynthesisSchema = z.object({
  title: z.string().min(1),
  executiveSummary: z.string().min(1),
  profiles: z.array(z.object({
    profileId: z.string().optional(),
    requestIds: z.array(z.string().min(1)).min(1),
    summary: z.string().min(1),
  })),
  runs: z.array(z.object({
    requestId: z.string().min(1),
    runId: z.string().min(1),
    trajectoryHighlights: z.array(z.string().min(1)),
  })),
  findings: z.array(z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().min(1),
    severity: z.enum(["critical", "high", "medium", "low", "info"]),
    evidence: z.array(evidenceReferenceSchema).min(1),
  })),
  actions: z.array(z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    priority: z.enum(["critical", "high", "medium", "low"]),
    description: z.string().min(1),
    relatedFindingIds: z.array(z.string().min(1)),
  })),
});

export type ReadoutSynthesis = z.infer<typeof readoutSynthesisSchema>;

function observationsForRun(evidence: ExactRunEvidence) {
  const criteriaById = new Map(evidence.criteria.map((criterion) => [criterion.id, criterion]));
  const mapResult = (
    result: CriterionResult,
    subject: "run" | "iteration",
  ) => {
    const criterion = criteriaById.get(result.criterionId);
    return {
      criterionId: result.criterionId,
      ...(criterion?.taxonomyElementId
        ? { taxonomyElementId: criterion.taxonomyElementId }
        : {}),
      subject,
      passed: result.passed,
      feedback: result.feedback,
    };
  };
  return [
    ...(evidence.run.observationResults ?? []).map((result) =>
      mapResult(result, "run")
    ),
    ...(evidence.run.turns ?? []).flatMap((turn) =>
      (turn.observationResults ?? []).map((result) =>
        mapResult(result, "iteration")
      )
    ),
  ];
}

export function composeExperimentReadout(
  evidence: ExperimentEvidence,
  synthesis: ReadoutSynthesis,
  generatedAt = new Date(),
): ExperimentReadout {
  const exactRuns = new Map(
    evidence.runs.map((entry) => [
      `${entry.request._id}:${entry.run._id}`,
      entry,
    ]),
  );
  const highlights = new Map(
    synthesis.runs.map((entry) => [
      `${entry.requestId}:${entry.runId}`,
      entry.trajectoryHighlights,
    ]),
  );
  for (const key of highlights.keys()) {
    if (!exactRuns.has(key)) {
      throw new Error(`Readout synthesis referenced non-vector run ${key}`);
    }
  }

  const criterionIds = new Set(
    evidence.runs.flatMap((entry) => entry.criteria.map((criterion) => criterion.id)),
  );
  for (const finding of synthesis.findings) {
    for (const reference of finding.evidence) {
      const key = `${reference.requestId}:${reference.runId}`;
      const exactRun = exactRuns.get(key);
      if (!exactRun) {
        throw new Error(`Readout finding ${finding.id} referenced non-vector run ${key}`);
      }
      if (
        reference.iteration !== undefined &&
        !(exactRun.run.turns ?? []).some(
          (turn) => turn.iteration === reference.iteration,
        )
      ) {
        throw new Error(
          `Readout finding ${finding.id} referenced unknown iteration ${reference.iteration} for ${key}`,
        );
      }
      if (reference.criterionId && !criterionIds.has(reference.criterionId)) {
        throw new Error(
          `Readout finding ${finding.id} referenced unknown criterion ${reference.criterionId}`,
        );
      }
    }
  }

  const runs = evidence.runs.map((entry) => ({
    requestId: entry.request._id,
    runId: entry.run._id,
    task: entry.request.scenario.task,
    workerType: entry.request.workerType,
    ...(entry.request.model ? { model: entry.request.model } : {}),
    ...(entry.request.profileId ? { profileId: entry.request.profileId } : {}),
    ...(entry.request.profileVersionId
      ? { profileVersionId: entry.request.profileVersionId }
      : {}),
    status: entry.run.status,
    ...(entry.run.outcome ? { outcome: entry.run.outcome } : {}),
    observations: observationsForRun(entry),
    trajectoryHighlights:
      highlights.get(`${entry.request._id}:${entry.run._id}`) ?? [],
  }));
  const allObservations = runs.flatMap((run) => run.observations);
  const synthesisProfiles = new Map(
    synthesis.profiles.map((profile) => [profile.profileId ?? "", profile]),
  );
  const requestIdsByProfile = new Map<string, string[]>();
  for (const entry of evidence.runs) {
    const key = entry.request.profileId ?? "";
    requestIdsByProfile.set(key, [
      ...(requestIdsByProfile.get(key) ?? []),
      entry.request._id,
    ]);
  }
  const profiles = [...requestIdsByProfile].map(([profileId, requestIds]) => ({
    ...(profileId ? { profileId } : {}),
    requestIds,
    summary:
      synthesisProfiles.get(profileId)?.summary ??
      `${requestIds.length} exact-vector run${requestIds.length === 1 ? "" : "s"}.`,
  }));
  const findingIds = new Set(synthesis.findings.map((finding) => finding.id));
  for (const action of synthesis.actions) {
    const unknown = action.relatedFindingIds.find((id) => !findingIds.has(id));
    if (unknown) {
      throw new Error(`Readout action ${action.id} referenced unknown finding ${unknown}`);
    }
  }

  return experimentReadoutSchema.parse({
    meta: {
      schemaId: EXPERIMENT_READOUT_SCHEMA_ID,
      schemaVersion: EXPERIMENT_READOUT_SCHEMA_VERSION,
      generatedAt: generatedAt.toISOString(),
      experimentId: evidence.experimentId,
      experimentExecutionId: evidence.experimentExecutionId,
    },
    summary: {
      title: synthesis.title,
      executiveSummary: synthesis.executiveSummary,
      totalRuns: runs.length,
      succeededRuns: runs.filter((run) => run.outcome === "succeeded").length,
      failedRuns: runs.filter((run) => run.outcome === "failed").length,
      passedObservations: allObservations.filter((result) => result.passed).length,
      failedObservations: allObservations.filter((result) => !result.passed).length,
    },
    profiles,
    runs,
    findings: synthesis.findings.map((finding) => ({
      ...finding,
      evidence: finding.evidence.map((reference) => ({
        experimentExecutionId: evidence.experimentExecutionId,
        ...reference,
      })),
    })),
    actions: synthesis.actions,
  });
}

export function renderExperimentReadoutMarkdown(readout: ExperimentReadout): string {
  const lines = [
    `# ${readout.summary.title}`,
    "",
    readout.summary.executiveSummary,
    "",
    "## Summary",
    "",
    `- Runs: ${readout.summary.totalRuns}`,
    `- Succeeded: ${readout.summary.succeededRuns}`,
    `- Failed: ${readout.summary.failedRuns}`,
    `- Passed observations: ${readout.summary.passedObservations}`,
    `- Failed observations: ${readout.summary.failedObservations}`,
    "",
    "## Runs",
    "",
  ];
  for (const run of readout.runs) {
    lines.push(
      `### ${run.task || run.requestId}`,
      "",
      `- Request: \`${run.requestId}\``,
      `- Run: \`${run.runId}\``,
      `- Status: ${run.status}${run.outcome ? ` / ${run.outcome}` : ""}`,
      `- Profile: ${run.profileId ?? "none"}`,
      "",
    );
    if (run.observations.length > 0) {
      lines.push("| Observation | Subject | Result | Evidence |", "| --- | --- | --- | --- |");
      for (const observation of run.observations) {
        lines.push(
          `| \`${observation.criterionId}\` | ${observation.subject} | ${observation.passed ? "Passed" : "Failed"} | ${observation.feedback.replaceAll("|", "\\|")} |`,
        );
      }
      lines.push("");
    }
    if (run.trajectoryHighlights.length > 0) {
      lines.push(
        "**Trajectory highlights**",
        "",
        ...run.trajectoryHighlights.map((highlight) => `- ${highlight}`),
        "",
      );
    }
  }
  lines.push("## Findings", "");
  if (readout.findings.length === 0) {
    lines.push("No cross-run findings were identified.", "");
  } else {
    for (const finding of readout.findings) {
      lines.push(
        `### ${finding.title}`,
        "",
        `**Severity:** ${finding.severity}`,
        "",
        finding.description,
        "",
        ...finding.evidence.map(
          (evidence) =>
            `- \`${evidence.requestId}/${evidence.runId}\`${evidence.iteration === undefined ? "" : ` iteration ${evidence.iteration}`}: ${evidence.excerpt}`,
        ),
        "",
      );
    }
  }
  lines.push("## Actions", "");
  if (readout.actions.length === 0) {
    lines.push("No follow-up actions were generated.", "");
  } else {
    for (const action of readout.actions) {
      lines.push(
        `- **${action.title}** (${action.priority}): ${action.description}`,
      );
    }
    lines.push("");
  }
  lines.push(
    "---",
    `Schema: \`${readout.meta.schemaId}@${readout.meta.schemaVersion}\``,
    `Experiment execution: \`${readout.meta.experimentExecutionId}\``,
  );
  return lines.join("\n");
}
