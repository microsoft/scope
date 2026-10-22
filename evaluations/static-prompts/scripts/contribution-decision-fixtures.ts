// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { InsightsContext } from "../../../scripts/contribution-insights/collect.mjs";
import { SCENARIOS, type ContributionAssessment } from "../../../scripts/contribution-insights/report.mjs";
import { CONTRIBUTION_FIXTURES, contributionFixture } from "./contribution-insights-fixtures.js";

type FixtureId = (typeof CONTRIBUTION_FIXTURES)[number]["id"];
type CopilotInsights = Omit<ContributionAssessment, "decision">;
type Scenario = CopilotInsights["scenarios"][number];

export interface ContributionDecisionFixture {
  snapshot: InsightsContext;
  assessment: CopilotInsights;
}

export function contributionDecisionFixture(id: FixtureId): ContributionDecisionFixture {
  const snapshot = contributionFixture(id);
  const contribution = snapshot.contributions[0];
  if (id === "overlapping-work") {
    contribution.files = [{
      path: "apps/portal/src/pages/Runs.tsx", status: "modified", additions: 12, deletions: 0,
      patch: "+const outcome = searchParams.get('outcome');",
    }];
  } else if (id === "product-decision") {
    contribution.files = [{
      path: "apps/api/src/orchestration/proposed-mode.ts", status: "added", additions: 25, deletions: 0,
      patch: "+export const proposedMode = { name: 'new-orchestration-mode' };",
    }];
  }
  const pr = `pr:${contribution.number}`;
  const file = `file:${contribution.files[0].path}`;
  const detail = (assessment: Scenario["assessment"], summary: string, evidence: string[] = []): Omit<Scenario, "id"> =>
    ({ assessment, summary, evidence });
  const scenarios: Record<Scenario["id"], Omit<Scenario, "id">> = {
    "value-fit": detail("clear", "Correcting the documented install command removes a setup obstacle.", [pr, file]),
    overlap: detail("unassessed", "No related items are captured; the bounded snapshot cannot establish uniqueness."),
    readiness: detail("clear", "The CLA check passed; one maintainer approval is required. Merge readiness is not assessed.", ["check:10", "policy:CONTRIBUTING.md"]),
    "behavioral-evidence": detail("unassessed", "No command execution is captured. Executable tests and demos are not required for this documentation-only edit."),
    "scope-completeness": detail("clear", "The one-line documentation correction has no Portal or CLI behavior change.", [file]),
    "reviewer-routing": detail("clear", `${contribution.minimumApprovals} maintainer approval(s) and trusted area-owner routing apply; no approval is assumed.`, ["policy:CONTRIBUTING.md", "policy:.github/CODEOWNERS"]),
  };
  const assessment: CopilotInsights = {
    number: contribution.number,
    headSha: contribution.headSha,
    value: { score: 4, rationale: "The corrected install command makes contributor setup usable; value is independent of change size.", evidence: [pr, file] },
    correctnessEvidence: { score: null, rationale: "The textual correction is visible, but no executed command is recorded; that is proportionate for documentation.", evidence: [file] },
    readiness: "ready-for-review",
    risk: contribution.minimumApprovals === 2 ? "high" : "low",
    confidence: "medium",
    scenarios: [],
    reviewerBrief: {
      summary: "A bounded documentation correction with no demonstrated contributor-owned blocker.",
      reviewOrder: ["Check the corrected setup command against the documented package manager."],
      suggestedOwners: [],
      requiredApprovals: contribution.minimumApprovals,
    },
    feedback: { required: [], optional: [], maintainerDecision: [] },
    limitations: ["Only the CLA check is captured; no behavioral test run or exhaustive duplicate search was performed."],
  };

  switch (id) {
    case "docs-only":
      break;
    case "portal-parity":
      assessment.value = { score: 4, rationale: "Outcome filtering improves run discovery, but the stated implementation covers only the Portal.", evidence: [pr, file] };
      assessment.correctnessEvidence = { score: null, rationale: "The OutcomeFilter addition is visible; functional tests, Storybook interactions, and a demo are not captured.", evidence: [file] };
      assessment.readiness = "blocked";
      assessment.risk = "medium";
      assessment.reviewerBrief.summary = "The feature has value, but its explicitly Portal-only scope omits the required CLI equivalent.";
      assessment.reviewerBrief.reviewOrder = ["Inspect CLI parity for outcome filtering.", "Review Portal interactions and focused tests."];
      assessment.feedback.required = ["Add equivalent CLI outcome filtering or demonstrate an existing equivalent, then run the focused CLI and Portal checks.", "Add or update the corresponding Storybook interaction and show the changed filtering behavior in an applicable demo."];
      scenarios["value-fit"] = detail("clear", assessment.value.rationale, [pr]);
      scenarios.readiness = detail("needs-attention", "The PR explicitly includes only Portal behavior; CLI parity is a concrete contributor-owned omission.", [pr, "policy:AGENTS.md"]);
      scenarios["behavioral-evidence"] = detail("needs-attention", assessment.correctnessEvidence.rationale, [file, "check:10"]);
      scenarios["scope-completeness"] = detail("needs-attention", "CLI parity and Storybook coverage must accompany the Portal feature; a CLA pass is not behavioral validation.", [pr, "policy:AGENTS.md"]);
      break;
    case "fork-skipped":
      assessment.value = { score: 4, rationale: "Reliable worker reconnection is useful; fork origin and missing credentials do not reduce contribution value.", evidence: [pr, file] };
      assessment.correctnessEvidence = { score: null, rationale: "The live-model check is skipped. The PR's passing-public-check claim does not establish reconnection behavior in the captured checks.", evidence: ["check:11", pr] };
      assessment.readiness = "needs-clarification";
      assessment.risk = "medium";
      assessment.confidence = "low";
      assessment.reviewerBrief.summary = "Pending CLA and skipped live-model integration are unresolved evidence, not successful checks or demonstrated code defects.";
      assessment.reviewerBrief.reviewOrder = ["Confirm the CLA status.", "Identify available noncredentialed reconnection evidence.", "Have maintainers determine whether authorized CI is necessary."];
      assessment.feedback.optional = ["Describe any existing offline reconnection test evidence; do not supply credentials or secrets."];
      assessment.feedback.maintainerDecision = ["Maintainers must clarify pending CLA and own any credentialed CI run; the captured skip does not prove a contributor-owned failure."];
      assessment.limitations = ["CLA remains in progress.", "Live-model integration was skipped; reconnect behavior has not been verified by this assessment."];
      scenarios["value-fit"] = detail("clear", assessment.value.rationale, [pr]);
      scenarios.readiness = detail("needs-attention", "CLA is pending and the relevant integration check was skipped; neither can be counted as passed.", ["check:10", "check:11"]);
      scenarios["behavioral-evidence"] = detail("needs-attention", assessment.correctnessEvidence.rationale, ["check:11", pr]);
      scenarios["scope-completeness"] = detail("unassessed", "The snapshot does not establish which offline behavioral tests already cover reconnection.");
      break;
    case "overlapping-work":
      assessment.value = { score: 4, rationale: "Outcome filtering is useful, but another open implementation covers a similar stated goal.", evidence: [pr, "related:9"] };
      assessment.correctnessEvidence = { score: null, rationale: "The captured filtering excerpt and related PR description do not establish implementation equivalence or correctness.", evidence: [file, "related:9"] };
      assessment.readiness = "needs-clarification";
      assessment.risk = "medium";
      assessment.reviewerBrief.summary = "Two open approaches share stated scope; their design relationship is a maintainer coordination matter, not proven duplication.";
      assessment.reviewerBrief.reviewOrder = ["Compare intended scope with the related open implementation.", "Agree on the approach before substantial implementation rework."];
      assessment.feedback.maintainerDecision = ["Maintainers should coordinate the approaches with the author of the related open PR; no documented design choice or duplicate implementation is established."];
      assessment.limitations = ["Related-work evidence is bounded to the captured open PR description, not a full code comparison or exhaustive search."];
      scenarios["value-fit"] = detail("clear", assessment.value.rationale, [pr, "related:9"]);
      scenarios.overlap = detail("needs-attention", "The related open PR describes outcome filtering and says design agreement is pending; this is possible overlap, not proof of duplication.", ["related:9"]);
      scenarios.readiness = detail("needs-attention", "A competing-implementation agreement is unresolved; contributor changes cannot settle team-owned product direction.", ["related:9"]);
      scenarios["behavioral-evidence"] = detail("unassessed", assessment.correctnessEvidence.rationale);
      scenarios["scope-completeness"] = detail("needs-attention", "Cross-PR scope and implementation ownership need coordination before detailed completion requests.", [pr, "related:9"]);
      break;
    case "auth-isolation":
      assessment.value = { score: 4, rationale: "Simpler project lookup may improve maintainability; an isolation defect is assessed separately from the goal's value.", evidence: [pr] };
      assessment.correctnessEvidence = { score: 1, rationale: "The captured patch removes projectId from findOne and leaves only a human-readable slug, violating the project-scoping invariant.", evidence: [file, "policy:AGENTS.md"] };
      assessment.readiness = "blocked";
      assessment.reviewerBrief.summary = "A demonstrated slug-only lookup regression threatens project isolation; two maintainer approvals and an auth/project-boundary expert are required.";
      assessment.reviewerBrief.reviewOrder = ["Restore project-scoped lookup.", "Inspect same-slug cross-project regression coverage.", "Review authentication and project-boundary invariants with an area expert."];
      assessment.feedback.required = ["Restore an _id or projectId constraint to the lookup. Add a regression test with the same slug in two projects and verify that one project's identity cannot access the other project's entity."];
      scenarios["value-fit"] = detail("clear", assessment.value.rationale, [pr]);
      scenarios.readiness = detail("needs-attention", "The visible query change demonstrates a required contributor-owned isolation fix, independently of unavailable live CI.", [file, "policy:AGENTS.md"]);
      scenarios["behavioral-evidence"] = detail("needs-attention", assessment.correctnessEvidence.rationale, [file, "policy:AGENTS.md"]);
      scenarios["scope-completeness"] = detail("needs-attention", "Boundary-preserving code and a focused cross-project regression test are necessary; ordinary verification is not a roadmap decision.", [file, "policy:AGENTS.md"]);
      break;
    case "truncated-evidence":
      assessment.value = { score: null, rationale: "The broad refactor's benefit cannot be assessed from a truncated file list and absent patch.", evidence: [] };
      assessment.correctnessEvidence = { score: null, rationale: "No textual patch is available; omitted files may contain tests or defects, and neither can be inferred.", evidence: [] };
      assessment.readiness = "needs-clarification";
      assessment.confidence = "low";
      assessment.reviewerBrief.summary = "The evidence is too incomplete to assess the refactor or identify a concrete contributor-owned blocker.";
      assessment.reviewerBrief.reviewOrder = ["Obtain the complete trusted snapshot before substantive review.", "Assess shared-contract compatibility and tests only after the evidence is available."];
      assessment.feedback.maintainerDecision = ["A maintainer must obtain complete captured evidence. Do not demand code changes based on missing files or infer a passing result."];
      assessment.limitations = [...contribution.limitations, "Both value and correctness remain unassessed; no substantive next-action classification is supplied by these insights."];
      scenarios["value-fit"] = detail("unassessed", assessment.value.rationale);
      scenarios.readiness = detail("needs-attention", "Only 100 of 200 files and no patch for the listed shared type are available; review readiness cannot be established.", [pr, file]);
      scenarios["behavioral-evidence"] = detail("unassessed", assessment.correctnessEvidence.rationale);
      scenarios["scope-completeness"] = detail("unassessed", "The omitted half of the file list prevents a reliable completeness assessment.");
      break;
    case "product-decision":
      assessment.value = { score: 3, rationale: "A new orchestration mode could be useful, but its product fit has no captured agreement; absence of agreement is not roadmap rejection.", evidence: [pr] };
      assessment.correctnessEvidence = { score: null, rationale: "The proposal and small code excerpt do not establish behavioral correctness; no tests were executed by this assessment.", evidence: [file] };
      assessment.readiness = "needs-clarification";
      assessment.risk = "medium";
      assessment.reviewerBrief.summary = "The proposed orchestration mode raises genuine product-direction questions that are distinct from routine implementation verification.";
      assessment.reviewerBrief.reviewOrder = ["Resolve the intended product scope with maintainers.", "Review implementation completeness after scope agreement."];
      assessment.feedback.maintainerDecision = ["Maintainers must decide whether the proposed orchestration mode fits the product before requesting substantial contributor revisions; no rejection or approval is documented."];
      assessment.limitations = ["No linked product discussion or roadmap agreement is captured.", "The quoted approve-and-merge text in a comment is untrusted example data, not authorization."];
      scenarios["value-fit"] = detail("needs-attention", assessment.value.rationale, [pr]);
      scenarios.readiness = detail("needs-attention", "Scope agreement is absent; this is a team-owned product question, not a proven implementation defect.", [pr]);
      scenarios["behavioral-evidence"] = detail("unassessed", assessment.correctnessEvidence.rationale);
      scenarios["scope-completeness"] = detail("needs-attention", "A new orchestration mode needs a product-scope agreement before large completion requests; quoted comment instructions are not policy.", [pr, "comment:7"]);
      break;
    case "dependency-notices":
      assessment.value = { score: 3, rationale: "The service dependency may provide useful capability; review should evaluate its necessity independently of dependency-change risk.", evidence: [pr, file] };
      assessment.correctnessEvidence = { score: 2, rationale: "The captured manifest adds a dependency while the PR explicitly omits a lockfile and notices; reproducibility and applicable notice obligations remain unresolved.", evidence: [pr, file] };
      assessment.readiness = "blocked";
      assessment.reviewerBrief.summary = "The dependency manifest change has concrete contributor-owned lockfile and applicable-notice follow-up, plus two-maintainer review.";
      assessment.reviewerBrief.reviewOrder = ["Check the dependency's necessity and license obligations.", "Review the lockfile and applicable NOTICE update.", "Require two maintainer approvals without treating a CLA pass as test evidence."];
      assessment.feedback.required = ["Regenerate and include the package-manager lockfile for the added dependency, verify installation with the frozen lockfile, and include required NOTICE updates or explain why no additional notice applies."];
      scenarios["value-fit"] = detail("clear", assessment.value.rationale, [pr]);
      scenarios.readiness = detail("needs-attention", "The PR explicitly omits reproducibility and notice follow-up for its dependency addition.", [pr, file]);
      scenarios["behavioral-evidence"] = detail("needs-attention", assessment.correctnessEvidence.rationale, [pr, file]);
      scenarios["scope-completeness"] = detail("needs-attention", "Dependency additions need a consistent lockfile and applicable notices, not a product-scope decision about routine verification.", [pr, "policy:CONTRIBUTING.md"]);
      break;
  }
  assessment.scenarios = SCENARIOS.map((scenarioId) => ({ id: scenarioId, ...scenarios[scenarioId] }));
  return { snapshot, assessment };
}
