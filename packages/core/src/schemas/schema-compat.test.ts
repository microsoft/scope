// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Compile-time type compatibility checks.
 *
 * These tests verify that the Zod-inferred types are structurally assignable
 * to/from the hand-written TypeScript interfaces. If a schema drifts from its
 * corresponding interface (missing field, wrong type, required vs optional
 * mismatch), `tsc` will fail before any runtime test executes.
 *
 * The follow-up phase that replaces interfaces with `z.infer<>` can delete this
 * file — at that point the schemas ARE the types and there's nothing to compare.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";

// --- Zod schemas ---
import {
  TokenUsageSchema,
  LogEventSchema,
  CriterionResultSchema,
  ConversationTurnSchema,
  RequestResponseSchema,
  PersonaSchema,
  ScenarioSchema,
  AgentVersionSchema,
  AgentResponseSchema,
  ModelResponseSchema,
  ReporterSchema,
  ReportResponseSchema,
  ReportTemplateResponseSchema,
  ReportTemplateSystemPromptSchema,
  InsightReferenceSchema,
  InsightResponseSchema,
  CriteriaResponseSchema,
  PromptFeatureResponseSchema,
  PromptFeatureResultSchema,
  SuggestedPromptFeatureSchema,
  PromptFeatureExtractionResponseSchema,
  TaskPromptResponseSchema,
  FeatureFlagResponseSchema,
  McpTransportTypeSchema,
  McpServerHeaderSchema,
  McpServerResponseSchema,
  SkillResponseSchema,
  SkillRevisionResponseSchema,
  SkillSearchResultSchema,
  SkillDiscoveryResultSchema,
  ReportTriggerSchema,
} from "./index.js";

// --- Hand-written TS interfaces ---
import type {
  TokenUsage,
  LogEvent,
  CriterionResult,
  ConversationTurn,
  RequestDocument,
  Persona,
  Scenario,
  AgentVersion,
  CodingAgentDocument,
  ModelDocument,
  Reporter,
  ReportDocument,
  ReportTemplateDocument,
  ReportTemplateSystemPrompt,
  InsightReference,
  InsightDocument,
  CriteriaDocument,
  PromptFeatureDocument,
  PromptFeatureResult,
  SuggestedPromptFeature,
  PromptFeatureExtraction,
  TaskPromptDocument,
  FeatureFlagDocument,
  ReportTrigger,
} from "../types/index.js";

import type {
  McpTransportType,
  McpServerHeader,
  McpServerDocument,
} from "../types/mcp.js";

import type {
  SkillDocument,
  SkillRevisionDocument,
  SkillSearchResult,
  SkillDiscoveryResult,
} from "../types/skill.js";

// ==========================================================================
// Helper: compile-time assignability assertion
//
// `assertAssignable<TSrc, TDest>()` compiles only if every required property
// in TDest exists in TSrc with a compatible type. This is a one-way check
// (schema → interface) because the Zod response schemas may include extra
// fields the interface doesn't have, which is fine under structural typing.
//
// We check the reverse direction too (interface → schema) where the schemas
// are meant to be exact mirrors, catching any fields the schema forgot.
// ==========================================================================

/**
 * Compiles only when T is assignable to U.
 * The unused parameter suppresses "declared but never read" warnings.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function assertAssignable<T extends U, U>(_?: undefined): void {
  // compile-time only — no runtime logic
}

// Inferred types from Zod schemas
type InferredTokenUsage = z.infer<typeof TokenUsageSchema>;
type InferredLogEvent = z.infer<typeof LogEventSchema>;
type InferredCriterionResult = z.infer<typeof CriterionResultSchema>;
type InferredConversationTurn = z.infer<typeof ConversationTurnSchema>;
type InferredRequestResponse = z.infer<typeof RequestResponseSchema>;
type InferredPersona = z.infer<typeof PersonaSchema>;
type InferredScenario = z.infer<typeof ScenarioSchema>;
type InferredAgentVersion = z.infer<typeof AgentVersionSchema>;
type InferredAgentResponse = z.infer<typeof AgentResponseSchema>;
type InferredModelResponse = z.infer<typeof ModelResponseSchema>;
type InferredReporter = z.infer<typeof ReporterSchema>;
type InferredReportResponse = z.infer<typeof ReportResponseSchema>;
type InferredReportTemplateResponse = z.infer<typeof ReportTemplateResponseSchema>;
type InferredReportTemplateSystemPrompt = z.infer<typeof ReportTemplateSystemPromptSchema>;
type InferredInsightReference = z.infer<typeof InsightReferenceSchema>;
type InferredInsightResponse = z.infer<typeof InsightResponseSchema>;
type InferredCriteriaResponse = z.infer<typeof CriteriaResponseSchema>;
type InferredPromptFeatureResponse = z.infer<typeof PromptFeatureResponseSchema>;
type InferredPromptFeatureResult = z.infer<typeof PromptFeatureResultSchema>;
type InferredSuggestedPromptFeature = z.infer<typeof SuggestedPromptFeatureSchema>;
type InferredPromptFeatureExtraction = z.infer<typeof PromptFeatureExtractionResponseSchema>;
type InferredTaskPromptResponse = z.infer<typeof TaskPromptResponseSchema>;
type InferredFeatureFlagResponse = z.infer<typeof FeatureFlagResponseSchema>;
type InferredMcpTransportType = z.infer<typeof McpTransportTypeSchema>;
type InferredMcpServerHeader = z.infer<typeof McpServerHeaderSchema>;
type InferredMcpServerResponse = z.infer<typeof McpServerResponseSchema>;
type InferredSkillResponse = z.infer<typeof SkillResponseSchema>;
type InferredSkillRevisionResponse = z.infer<typeof SkillRevisionResponseSchema>;
type InferredSkillSearchResult = z.infer<typeof SkillSearchResultSchema>;
type InferredSkillDiscoveryResult = z.infer<typeof SkillDiscoveryResultSchema>;
type InferredReportTrigger = z.infer<typeof ReportTriggerSchema>;

// ==========================================================================
// Compile-time checks: Schema → Interface (Zod output assignable to TS type)
//
// If any of these fail to compile, the Zod schema is missing a field or has
// the wrong type compared to the hand-written interface.
// ==========================================================================

// Primitives & enums
assertAssignable<InferredMcpTransportType, McpTransportType>();

// Value objects
assertAssignable<InferredTokenUsage, TokenUsage>();
assertAssignable<InferredLogEvent, LogEvent>();
assertAssignable<InferredCriterionResult, CriterionResult>();
assertAssignable<InferredPersona, Persona>();
assertAssignable<InferredScenario, Scenario>();
assertAssignable<InferredMcpServerHeader, McpServerHeader>();
assertAssignable<InferredReportTemplateSystemPrompt, ReportTemplateSystemPrompt>();
assertAssignable<InferredPromptFeatureResult, PromptFeatureResult>();
assertAssignable<InferredSuggestedPromptFeature, SuggestedPromptFeature>();
assertAssignable<InferredInsightReference, InsightReference>();
assertAssignable<InferredReporter, Reporter>();

// Document types: Schema → Interface
// These check that the Zod response schema produces all fields the TS interface requires.
assertAssignable<InferredConversationTurn, ConversationTurn>();
assertAssignable<InferredAgentVersion, AgentVersion>();
assertAssignable<InferredAgentResponse, CodingAgentDocument>();
assertAssignable<InferredModelResponse, ModelDocument>();
assertAssignable<InferredReportResponse, ReportDocument>();
assertAssignable<InferredReportTemplateResponse, ReportTemplateDocument>();
assertAssignable<InferredInsightResponse, InsightDocument>();
assertAssignable<InferredCriteriaResponse, CriteriaDocument>();
assertAssignable<InferredPromptFeatureResponse, PromptFeatureDocument>();
assertAssignable<InferredTaskPromptResponse, TaskPromptDocument>();
assertAssignable<InferredFeatureFlagResponse, FeatureFlagDocument>();
assertAssignable<InferredMcpServerResponse, McpServerDocument>();
assertAssignable<InferredSkillResponse, SkillDocument>();
assertAssignable<InferredSkillRevisionResponse, SkillRevisionDocument>();
assertAssignable<InferredSkillSearchResult, SkillSearchResult>();
assertAssignable<InferredSkillDiscoveryResult, SkillDiscoveryResult>();

// Discriminated unions
assertAssignable<InferredReportTrigger, ReportTrigger>();

// RequestDocument is the big one — many fields
assertAssignable<InferredRequestResponse, RequestDocument>();

// ==========================================================================
// Compile-time checks: Interface → Schema (TS type assignable to Zod output)
//
// These catch fields the interface has that the schema forgot. Under structural
// typing, extra fields are fine, so we only check the reverse for document types
// where the schema should be an exact mirror.
// ==========================================================================

// Value objects (bidirectional — should be exact mirrors)
assertAssignable<TokenUsage, InferredTokenUsage>();
assertAssignable<LogEvent, InferredLogEvent>();
assertAssignable<CriterionResult, InferredCriterionResult>();
assertAssignable<Persona, InferredPersona>();
assertAssignable<Scenario, InferredScenario>();
assertAssignable<McpServerHeader, InferredMcpServerHeader>();
assertAssignable<ReportTemplateSystemPrompt, InferredReportTemplateSystemPrompt>();
assertAssignable<PromptFeatureResult, InferredPromptFeatureResult>();
assertAssignable<SuggestedPromptFeature, InferredSuggestedPromptFeature>();
assertAssignable<InsightReference, InferredInsightReference>();
assertAssignable<Reporter, InferredReporter>();
assertAssignable<McpTransportType, InferredMcpTransportType>();
assertAssignable<SkillSearchResult, InferredSkillSearchResult>();
assertAssignable<SkillDiscoveryResult, InferredSkillDiscoveryResult>();
assertAssignable<ReportTrigger, InferredReportTrigger>();

// ---------------------------------------------------------------------------
// Runtime test (Vitest needs at least one `it` block to count the file)
// ---------------------------------------------------------------------------
describe("schema ↔ interface type compatibility", () => {
  it("compiles — all Zod schemas are structurally compatible with TS interfaces", () => {
    // If this file compiles, the types match. This test just records the fact.
    expect(true).toBe(true);
  });
});
