// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";

const scoreSchema = z.number().min(0).max(100);
const frequencySchema = z.number().min(0).max(1);

/** Taxonomy document metadata. */
export const taxonomyMetaSchema = z.object({
  generatedAt: z.string().datetime({ offset: true }),
  schemaVersion: z.string().min(1),
  runId: z.string().min(1),
  requestId: z.string().min(1),
});

/** Scorecard dimension result for a single profile. */
export const scorecardDimensionSchema = z.object({
  name: z.string().min(1),
  score: scoreSchema,
  rationale: z.string().min(1),
  evidence: z.array(z.string().min(1)),
});

/** Scorecard result for a specific profile slice. */
export const profileResultSchema = z.object({
  profileId: z.string().min(1),
  select: z.enum(["best", "median", "worst"]),
  taskOutcome: z.enum(["success", "partial", "failure"]),
  overallScore: scoreSchema,
  dimensions: z.array(scorecardDimensionSchema),
});

/** Top-level scorecard section summarizing profile results. */
export const scorecardSchema = z.object({
  summary: z.string().min(1),
  profileResults: z.array(profileResultSchema),
  crossProfileInsights: z.array(z.string().min(1)),
});

/** Evidence excerpt supporting an observed behavior pattern. */
export const behaviorEvidenceSchema = z.object({
  runId: z.string().min(1),
  iteration: z.number().int().min(0),
  excerpt: z.string().min(1),
});

/** Cross-run behavioral pattern identified by the taxonomy analysis. */
export const behaviorPatternSchema = z.object({
  id: z.string().min(1),
  category: z.enum(["strength", "weakness", "inconsistency", "regression"]),
  title: z.string().min(1),
  description: z.string().min(1),
  frequency: frequencySchema,
  impact: z.enum(["critical", "high", "medium", "low"]),
  evidence: z.array(behaviorEvidenceSchema),
});

/** Qualitative description of the agent's personality traits. */
export const agentPersonalitySchema = z.object({
  communicationStyle: z.string().min(1),
  problemSolvingApproach: z.string().min(1),
  errorRecoveryBehavior: z.string().min(1),
});

/** Behavior analysis section describing patterns and personality. */
export const behaviorAnalysisSchema = z.object({
  patterns: z.array(behaviorPatternSchema),
  agentPersonality: agentPersonalitySchema,
});

/** Action item emitted by the taxonomy analysis. */
export const actionItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  priority: z.enum(["critical", "high", "medium", "low"]),
  description: z.string().min(1),
  ownership: z.enum([
    "agent-team",
    "platform-team",
    "prompt-engineer",
    "scenario-author",
  ]),
  relatedPatterns: z.array(z.string().min(1)),
  suggestedApproach: z.string().min(1),
});

/** Prioritized action lists grouped by remediation intent. */
export const actionListSchema = z.object({
  fix: z.array(actionItemSchema),
  improve: z.array(actionItemSchema),
  investigate: z.array(actionItemSchema),
});

/** Complete taxonomy document produced by the taxonomy post-processor. */
export const taxonomySchema = z.object({
  meta: taxonomyMetaSchema,
  scorecard: scorecardSchema,
  behaviorAnalysis: behaviorAnalysisSchema,
  actionList: actionListSchema,
});

/** Inferred TypeScript type for the taxonomy document. */
export type TaxonomyDocument = z.infer<typeof taxonomySchema>;
