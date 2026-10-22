// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Contribution, InsightsContext } from "./collect.mjs";
import type { DecisionAction, FinalDecision } from "./decision.mjs";

export const SCENARIOS = [
  "value-fit",
  "overlap",
  "readiness",
  "behavioral-evidence",
  "scope-completeness",
  "reviewer-routing",
] as const;

interface Rating {
  score: number | null;
  rationale: string;
  evidence: string[];
}

export interface ContributionAssessment {
  number: number;
  headSha: string;
  value: Rating;
  correctnessEvidence: Rating;
  readiness: "blocked" | "needs-clarification" | "ready-for-review";
  risk: "low" | "medium" | "high";
  confidence: "low" | "medium" | "high";
  decision?: FinalDecision;
  scenarios: Array<{
    id: (typeof SCENARIOS)[number];
    assessment: "clear" | "needs-attention" | "unassessed";
    summary: string;
    evidence: string[];
  }>;
  reviewerBrief: { summary: string; reviewOrder: string[]; suggestedOwners: string[]; requiredApprovals: 1 | 2 };
  feedback: { required: string[]; optional: string[]; maintainerDecision: string[] };
  limitations: string[];
}

export interface ContributionReport {
  schemaVersion: 2;
  assessments: ContributionAssessment[];
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4_000) {
    throw new Error(`${label} must be a nonempty string of at most 4000 characters`);
  }
  if (/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|Bearer\s+(?!\[REDACTED_TOKEN\])[A-Za-z0-9._~+/=-]+)\b/i.test(value)) {
    throw new Error(`${label} contains a possible credential`);
  }
  if (/https?:\/\/|<[^>]*>/i.test(value)) throw new Error(`${label} must use evidence IDs instead of URLs or HTML`);
  return value;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error(`${label} must be an array of at most 20 strings`);
  return value.map((item) => string(item, label));
}

function oneOf<const T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) throw new Error(`${label} must be one of ${allowed.join(", ")}`);
  return match;
}

export function evidenceLinks(context: InsightsContext, contribution: Contribution): Map<string, string> {
  const links = new Map<string, string>([[`pr:${contribution.number}`, contribution.url]]);
  for (const file of contribution.files) {
    const revision = file.status === "removed" ? contribution.baseSha : contribution.headSha;
    links.set(`file:${file.path}`, `https://github.com/${context.repository}/blob/${revision}/${file.path.split("/").map(encodeURIComponent).join("/")}`);
  }
  for (const item of [...contribution.checks, ...contribution.comments]) links.set(item.evidenceId, item.url);
  for (const item of contribution.related) links.set(`related:${item.number}`, item.url);
  for (const policy of context.policies) {
    links.set(`policy:${policy.path}`, context.policySource === "working-tree" ? "context.json" :
      `https://github.com/${context.repository}/blob/${context.trustedRevision}/${policy.path}`);
  }
  return links;
}

export function parseReport(raw: string, context: InsightsContext): ContributionReport {
  if (raw.length > 120_000) throw new Error("Contribution report exceeds 120000 characters");
  const root = object(JSON.parse(raw) as unknown, "report");
  if (root.schemaVersion !== 2 || !Array.isArray(root.assessments) ||
    root.assessments.length !== context.contributions.length) {
    throw new Error("Report must have schemaVersion 2 and exactly one insight assessment for every captured contribution");
  }
  const seen = new Set<number>();
  const assessments = root.assessments.map((value): ContributionAssessment => {
    const item = object(value, "assessment");
    if ("recommendation" in item || "decision" in item) {
      throw new Error("Copilot must provide insights only; final decisions belong exclusively to Microsoft-Decision-1");
    }
    const contribution = context.contributions.find((candidate) => candidate.number === item.number);
    if (!contribution || seen.has(contribution.number) || item.headSha !== contribution.headSha) {
      throw new Error("Assessment has a duplicate, unknown PR number, or stale head SHA");
    }
    seen.add(contribution.number);
    const links = evidenceLinks(context, contribution);
    const evidence = (value: unknown): string[] => {
      const ids = strings(value, "evidence");
      if (ids.some((id) => !links.has(id))) throw new Error("Assessment cites evidence absent from its captured PR snapshot");
      return ids;
    };
    const rating = (value: unknown, label: string): Rating => {
      const entry = object(value, label);
      if (entry.score !== null && (typeof entry.score !== "number" || !Number.isInteger(entry.score) || entry.score < 1 || entry.score > 5)) {
        throw new Error(`${label}.score must be null or an integer from 1 to 5`);
      }
      const ids = evidence(entry.evidence);
      if (entry.score !== null && !ids.length) throw new Error(`${label} needs evidence for a numeric score`);
      return { score: entry.score, rationale: string(entry.rationale, `${label}.rationale`), evidence: ids };
    };
    if (!Array.isArray(item.scenarios) || item.scenarios.length !== SCENARIOS.length) {
      throw new Error("Every assessment must cover all six P0 scenarios");
    }
    const scenarioIds = new Set<string>();
    const scenarios = item.scenarios.map((value): ContributionAssessment["scenarios"][number] => {
      const scenario = object(value, "scenario");
      const id = oneOf(scenario.id, SCENARIOS, "scenario ID");
      if (scenarioIds.has(id)) throw new Error("Duplicate scenario ID");
      scenarioIds.add(id);
      const assessment = oneOf(scenario.assessment, ["clear", "needs-attention", "unassessed"], "scenario assessment");
      const ids = evidence(scenario.evidence);
      if (assessment !== "unassessed" && !ids.length) throw new Error("Assessed scenarios require evidence");
      return { id, assessment, summary: string(scenario.summary, "scenario summary"), evidence: ids };
    });
    const brief = object(item.reviewerBrief, "reviewer brief");
    if ((brief.requiredApprovals !== 1 && brief.requiredApprovals !== 2) ||
      brief.requiredApprovals < contribution.minimumApprovals) {
      throw new Error("Reviewer brief understates the repository approval policy");
    }
    const owners = new Set(context.policies.find((policy) => policy.path === ".github/CODEOWNERS")?.content.match(/@[A-Za-z0-9_/-]+/g) ?? []);
    const suggestedOwners = strings(brief.suggestedOwners, "suggested owners");
    if (suggestedOwners.some((owner) => !owners.has(owner))) throw new Error("Suggested reviewer is absent from trusted CODEOWNERS");
    const confidence = oneOf(item.confidence, ["low", "medium", "high"], "confidence");
    if (confidence === "high" && contribution.limitations.length) {
      throw new Error("High confidence is not allowed with incomplete captured evidence");
    }
    const risk = oneOf(item.risk, ["low", "medium", "high"], "risk");
    if (risk === "low" && brief.requiredApprovals === 2) throw new Error("Sensitive changes cannot be rated low risk");
    const feedback = object(item.feedback, "feedback");
    return {
      number: contribution.number, headSha: contribution.headSha,
      value: rating(item.value, "value"), correctnessEvidence: rating(item.correctnessEvidence, "correctness evidence"),
      readiness: oneOf(item.readiness, ["blocked", "needs-clarification", "ready-for-review"], "readiness"),
      risk, confidence,
      scenarios,
      reviewerBrief: {
        summary: string(brief.summary, "reviewer summary"), reviewOrder: strings(brief.reviewOrder, "review order"),
        suggestedOwners, requiredApprovals: brief.requiredApprovals,
      },
      feedback: {
        required: strings(feedback.required, "required feedback"), optional: strings(feedback.optional, "optional feedback"),
        maintainerDecision: strings(feedback.maintainerDecision, "maintainer decisions"),
      },
      limitations: strings(item.limitations, "limitations"),
    };
  });
  return { schemaVersion: 2, assessments };
}

function escape(value: string): string {
  return value.replace(/[\\`*_[\]<>|#]/g, "\\$&").replace(/\r?\n/g, " ");
}

function list(values: string[]): string {
  return values.length ? values.map((value) => `- ${escape(value)}`).join("\n") : "None identified.";
}

function ratingLabel(rating: Rating): string {
  return rating.score === null ? "Unassessed" : `${rating.score}/5`;
}

function summaryExcerpt(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  const first = [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(text)][0]?.segment.trim() ?? text;
  if (first.length <= 240) return first;
  const excerpt = first.slice(0, 237);
  const boundary = excerpt.lastIndexOf(" ");
  return `${excerpt.slice(0, boundary > 0 ? boundary : excerpt.length)}...`;
}

export function renderReport(report: ContributionReport, context: InsightsContext): string {
  const recommendations: Record<DecisionAction, string> = {
    "prioritize-review": "Prioritize review",
    "request-clarification": "Clarification needed",
    "request-contributor-changes": "Contributor changes needed",
    "maintainer-scope-decision": "Maintainer scope decision",
    "manual-review-required": "Manual review required",
  };
  const sections = [
    "# Contribution Insights",
    "",
    "## Summary",
  ];
  if (!report.assessments.length) sections.push("", "No eligible community contributions were selected.");
  for (const assessment of report.assessments) {
    const contribution = context.contributions.find((candidate) => candidate.number === assessment.number);
    if (!contribution) throw new Error("Cannot summarize an assessment without its snapshot");
    if (report.assessments.length > 1) sections.push("", `### PR #${contribution.number}`);
    const decision = assessment.decision;
    const finalAction = decision?.status === "completed" ? recommendations[decision.action] : "Unavailable";
    const nextAction = decision?.status === "completed"
      ? assessment.feedback.maintainerDecision[0] ?? assessment.reviewerBrief.reviewOrder[0] ?? assessment.reviewerBrief.summary
      : "Configure or restore Microsoft-Decision-1; Copilot insights remain available.";
    const nextActionPreview = summaryExcerpt(nextAction);
    const caveat = contribution.checks.length === 1 && contribution.cla === "passed"
      ? "Only the CLA check passed in the captured evidence; behavioral tests were not verified."
      : contribution.limitations[0] ?? assessment.limitations[0] ??
        "Only captured evidence was considered; this assessment did not run tests.";
    sections.push(
      "", `[#${contribution.number}](${contribution.url}): ${escape(contribution.title)}`,
      "", escape(summaryExcerpt(assessment.value.rationale)),
      "", "### TL;DR",
      "", "| Signal | Summary |", "| --- | --- |",
      `| Final decision | **${finalAction}** |`,
      `| Value | **${ratingLabel(assessment.value)}** |`,
      `| Correctness evidence | **${ratingLabel(assessment.correctnessEvidence)}** |`,
      `| Risk / insight confidence | **${assessment.risk}** / **${assessment.confidence}** |`,
      `| Contributor action | ${assessment.feedback.required.length
        ? `${assessment.feedback.required.length} required item(s); see Required below`
        : "No required changes identified"} |`,
      `| ${decision?.status === "completed" && assessment.feedback.maintainerDecision.length ? "Maintainer action" : "Next action"} | ${escape(nextActionPreview)} |`,
      `| Evidence caveat | ${escape(summaryExcerpt(caveat))} |`,
      "| Merge readiness | **Not assessed** |",
      "",
      `Decision: **Microsoft-Decision-1 (${decision?.status ?? "not-configured"})**. Insights and feedback: **Copilot**.`,
    );
    if (decision?.status === "failed") sections.push("", `**No final decision.** ${escape(decision.error)}`);
    if (assessment.feedback.required.length) sections.push("", "#### Required", "", list(assessment.feedback.required));
    const remainingMaintainerActions = assessment.feedback.maintainerDecision.filter((item, index) =>
      index !== 0 || decision?.status !== "completed" || item !== nextActionPreview);
    if (remainingMaintainerActions.length) {
      sections.push("", "#### Needs maintainer decision", "", list(remainingMaintainerActions));
    }
  }
  sections.push(
    "",
    "**Report-only pilot.** No result approves a merge. Feedback is a draft and was not posted.",
  );
  if (context.selection.limitations.length) sections.push("", "### Batch limitations", "", list(context.selection.limitations));
  sections.push("", "<details>", "<summary>Full evidence and model details</summary>", "");
  for (const assessment of report.assessments) {
    const contribution = context.contributions.find((candidate) => candidate.number === assessment.number);
    if (!contribution) throw new Error("Cannot render an assessment without its snapshot");
    const links = evidenceLinks(context, contribution);
    const citations = (ids: string[]): string => ids.map((id) => `[${escape(id)}](${links.get(id)})`).join(", ") || "Unassessed";
    sections.push(
      "", `## [PR #${contribution.number}](${contribution.url}): ${escape(contribution.title)}`,
      "", `Head: \`${contribution.headSha}\`. Base: \`${contribution.baseSha}\`. Draft: ${contribution.draft}.`,
      "", "### Copilot insight scorecard",
      "", "| Dimension | Assessment | Rationale |",
      "| --- | --- | --- |",
      `| Value | ${ratingLabel(assessment.value)} | ${escape(assessment.value.rationale)} ${citations(assessment.value.evidence)} |`,
      `| Correctness evidence | ${ratingLabel(assessment.correctnessEvidence)} | ${escape(assessment.correctnessEvidence.rationale)} ${citations(assessment.correctnessEvidence.evidence)} |`,
      `| Review readiness | ${assessment.readiness} | Copilot insight; not the final decision or merge readiness |`,
      "", "### Final decision: Microsoft-Decision-1",
      "",
      assessment.decision?.status === "completed"
        ? `**${recommendations[assessment.decision.action]}**. Model: \`${assessment.decision.model}\`.`
        : assessment.decision?.status === "failed"
          ? `**No final decision.** ${escape(assessment.decision.error)}`
          : "**No final decision.** Microsoft-Decision-1 is not configured. Copilot is not used as a fallback decision-maker.",
      ...(assessment.decision?.status === "completed" ? [
        "",
        "| Action | Model probability |", "| --- | --- |",
        ...Object.entries(assessment.decision.probabilities).map(([action, value]) =>
          `| ${recommendations[action as DecisionAction]} | ${(value * 100).toFixed(2)}% |`),
        "",
        `Model confidence: ${assessment.decision.confidence === null ? "not supplied" : `${(assessment.decision.confidence * 100).toFixed(2)}%`}. Probabilities are not calibrated proof of correctness.`,
        "",
        `Question version: \`${assessment.decision.questionVersion}\`. Input SHA-256: \`${assessment.decision.inputSha256}\`.`,
      ] : []),
      "",
      "Decision-1 supplies no written rationale. Copilot insights do not explain its internal reasoning. Human approvals and required checks remain mandatory.",
      "", "### Captured CI and CLA facts",
      "", `CLA (exact \`license/cla\` context from the verified Microsoft policy publisher): **${contribution.cla}**. A matching name alone is not CLA proof.`,
      "", "| Check | Status | Conclusion | Publisher | Evidence |", "| --- | --- | --- | --- | --- |",
      ...contribution.checks.map((check) =>
        `| ${escape(check.name)} | ${escape(check.status)} | ${escape(check.conclusion ?? "pending")} | ${escape(check.publisher)} | ${citations([check.evidenceId])} |`),
      "", "Skipped, neutral, missing, pending, and inaccessible checks are not passing test evidence. Required-check policy and live-model access are not established by this report.",
      "", "### P0 scenarios",
      "", "| Area | Status | Finding | Evidence |", "| --- | --- | --- | --- |",
      ...SCENARIOS.map((id) => {
        const scenario = assessment.scenarios.find((candidate) => candidate.id === id);
        if (!scenario) throw new Error(`Missing ${id}`);
        return `| ${id} | ${scenario.assessment} | ${escape(scenario.summary)} | ${citations(scenario.evidence)} |`;
      }),
      "", "### Reviewer brief", "", escape(assessment.reviewerBrief.summary),
      "", `Required: **${assessment.reviewerBrief.requiredApprovals} team maintainer approval(s)**, including an area expert for sensitive changes. Approvals were not verified.`,
      "", `Suggested CODEOWNERS: ${assessment.reviewerBrief.suggestedOwners.map(escape).join(", ") || "Needs maintainer routing"}.`,
      "", list(assessment.reviewerBrief.reviewOrder),
      ...(assessment.feedback.optional.length ? ["", "#### Optional", "", list(assessment.feedback.optional)] : []),
      "", "### Limitations", "", list([...new Set([...contribution.limitations, ...assessment.limitations])]),
    );
  }
  sections.push(
    "", "### Snapshot",
    "",
    context.policySource === "working-tree"
      ? `Collected: ${context.collectedAt}. Local working-tree policies are captured in context.json; checkout base: \`${context.trustedRevision}\`.`
      : `Collected: ${context.collectedAt}. Trusted policy revision: \`${context.trustedRevision}\`.`,
    "", `Considered ${context.selection.considered} PRs; captured ${context.selection.selected}.`,
    "", "</details>",
  );
  return `${sections.join("\n")}\n`;
}
