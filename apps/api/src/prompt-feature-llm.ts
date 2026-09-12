// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { isUnexpected } from "@azure-rest/ai-inference";
import { PromptFeatureConfig, PromptFeatureResult, SuggestedPromptFeature } from "shared";
import { acquireInferenceClient, isLlmAvailable as inferenceAvailable } from "./llm-token.js";

// ---------------------------------------------------------------------------
// Generate prompt feature prompt (mirrors criteria generateCriteriaPrompt)
// ---------------------------------------------------------------------------

const GENERATE_SYSTEM_PROMPT = `You are an expert at writing detection prompts for AI coding agent benchmark task analysis.

Given a natural-language description of a characteristic to detect in a task prompt (the instructions given to a coding agent), you must:

1. Write a concise detection prompt (1-3 sentences) that an LLM will use to decide whether a task prompt exhibits that characteristic. The prompt should be specific about what phrases, patterns, or requirements to look for. Keep it factual and objective.

2. Suggest a short, descriptive snake_case identifier for this prompt feature. The ID must:
   - Start with "asks_for_" or a similar verb prefix
   - Contain only lowercase letters, digits, and underscores
   - Be concise but descriptive (e.g., asks_for_testing, asks_for_api, asks_for_docker)

3. Suggest **parent dependencies** — existing prompt features that should logically be detected BEFORE this one can be evaluated. For example, if the new feature checks for "Azure Functions", it likely depends on "asks_for_azure" being detected first. Only suggest IDs from the provided existing list.

4. Suggest **children dependents** — existing prompt features that should logically depend on this new feature. Only suggest IDs from the provided existing list.

Here are examples of good detection prompts:
- "The task prompt asks the agent to use, deploy to, or configure cloud infrastructure or services (Azure, AWS, GCP)."
- "The task prompt asks the agent to create or modify a REST API, web service, HTTP server, or backend endpoint."
- "The task prompt asks the agent to write tests, add test coverage, or set up a testing framework."

Respond with ONLY a JSON object in this exact format (no markdown, no code fences):
{"prompt": "your detection prompt here", "suggestedId": "asks_for_something", "suggestedParents": ["existing_id_1"], "suggestedChildren": ["existing_id_2"]}

If no parents or children are appropriate, use empty arrays.`;

export interface ExistingPromptFeature {
  id: string;
  prompt: string;
}

export interface GeneratePromptFeatureResult {
  prompt: string;
  suggestedId: string;
  suggestedParents: string[];
  suggestedChildren: string[];
}

export function isLlmAvailable(): boolean {
  return inferenceAvailable();
}

function buildGenerateUserMessage(behavior: string, existing: ExistingPromptFeature[]): string {
  const parts: string[] = [];

  if (existing.length > 0) {
    parts.push("EXISTING PROMPT FEATURES (use only these IDs for parent/children suggestions):");
    for (const f of existing) {
      parts.push(`- ${f.id}: ${f.prompt}`);
    }
    parts.push("");
  }

  parts.push(`NEW PROMPT FEATURE TO CREATE:\n${behavior}`);
  return parts.join("\n");
}

export async function generatePromptFeaturePrompt(
  behavior: string,
  existingFeatures: ExistingPromptFeature[] = [],
  model?: string,
): Promise<GeneratePromptFeatureResult> {
  const { client: llm, model: foundryModel } = await acquireInferenceClient();

  // Priority: explicit arg > key-specific (from Foundry blob) > env > default.
  const modelName = model || foundryModel || process.env.LLM_MODEL || "gpt-4.1";
  const userMessage = buildGenerateUserMessage(behavior, existingFeatures);

  const response = await llm.path("/chat/completions").post({
    body: {
      messages: [
        { role: "system", content: GENERATE_SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      model: modelName,
      temperature: 0.3,
      max_tokens: 512,
    },
  });

  if (isUnexpected(response)) {
    const errBody = response.body as any;
    throw new Error(
      `LLM request failed: ${errBody?.error?.message || response.status}`,
    );
  }

  const content = response.body.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("LLM returned empty response");
  }

  const cleaned = content.replace(/```json\s*|```\s*/g, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed.prompt || !parsed.suggestedId) {
      throw new Error("Missing required fields");
    }

    const sanitizedId = parsed.suggestedId
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .replace(/^[^a-z]+/, "")
      .replace(/_+/g, "_")
      .replace(/_$/, "");

    const existingIds = new Set(existingFeatures.map((f) => f.id));
    const suggestedParents = Array.isArray(parsed.suggestedParents)
      ? parsed.suggestedParents.filter((pid: string) => existingIds.has(pid))
      : [];
    const suggestedChildren = Array.isArray(parsed.suggestedChildren)
      ? parsed.suggestedChildren.filter((cid: string) => existingIds.has(cid))
      : [];

    return {
      prompt: parsed.prompt.trim(),
      suggestedId: sanitizedId || "asks_for_something",
      suggestedParents,
      suggestedChildren,
    };
  } catch {
    throw new Error(`Failed to parse LLM response as JSON: ${cleaned}`);
  }
}

// ---------------------------------------------------------------------------
// Extract prompt features from a task prompt
// ---------------------------------------------------------------------------

const EXTRACT_SYSTEM_PROMPT = `You are an expert at analyzing task prompts for AI coding agent benchmarks.

Given a task prompt (the instructions given to a coding agent) and optionally a list of prompt features to detect, you must:

1. If existing features are provided, determine which are present in the task prompt. A feature is "detected" if the task prompt explicitly or implicitly asks for, mentions, or requires the characteristic described by that feature.

2. Suggest NEW features that the task prompt exhibits but that are NOT covered by any of the existing features. Only suggest features that represent clearly distinct, meaningful characteristics. Each suggestion needs:
   - suggestedId: a snake_case identifier starting with a verb prefix (e.g., asks_for_X, requires_X, uses_X)
   - behavior: a short natural-language description of the characteristic
   - prompt: a concise detection prompt (1-3 sentences) for an LLM to detect this characteristic in other task prompts

Respond with ONLY a JSON object in this exact format (no markdown, no code fences):
{"results": [{"featureId": "feature_id_here", "detected": true}, {"featureId": "other_feature", "detected": false}], "suggestedFeatures": [{"suggestedId": "asks_for_something", "behavior": "short description", "prompt": "detection prompt"}]}

If no existing features are provided, "results" should be an empty array — focus on suggesting new features instead. Include ALL provided features in "results" if any are given. Be precise — only mark a feature as detected if the task prompt clearly relates to it. If no new features should be suggested, use an empty array for "suggestedFeatures".`;

function buildExtractUserMessage(taskText: string, features: PromptFeatureConfig[]): string {
  const parts: string[] = [];

  if (features.length > 0) {
    parts.push("PROMPT FEATURES TO DETECT:");
    for (const f of features) {
      parts.push(`- ${f.id}: ${f.prompt}`);
    }
  } else {
    parts.push("PROMPT FEATURES TO DETECT:\n(none defined yet \u2014 suggest new features based on the task prompt)");
  }
  parts.push("");
  parts.push(`TASK PROMPT TO ANALYZE:\n${taskText}`);

  return parts.join("\n");
}

export interface ExtractionResult {
  results: PromptFeatureResult[];
  suggestedFeatures: SuggestedPromptFeature[];
}

export async function extractPromptFeatures(
  taskText: string,
  features: PromptFeatureConfig[],
  model?: string,
): Promise<ExtractionResult> {
  const { client: llm, model: foundryModel } = await acquireInferenceClient();

  // Priority: explicit arg > key-specific (from Foundry blob) > env > default.
  const modelName = model || foundryModel || process.env.LLM_MODEL || "gpt-4.1";
  const userMessage = buildExtractUserMessage(taskText, features);

  const response = await llm.path("/chat/completions").post({
    body: {
      messages: [
        { role: "system", content: EXTRACT_SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      model: modelName,
      temperature: 0.1,  // Lower temperature for more deterministic detection
      max_tokens: 2048,
    },
  });

  if (isUnexpected(response)) {
    const errBody = response.body as any;
    throw new Error(
      `LLM extraction failed: ${errBody?.error?.message || response.status}`,
    );
  }

  const content = response.body.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("LLM returned empty response");
  }

  const cleaned = content.replace(/```json\s*|```\s*/g, "").trim();
  try {
    const parsed = JSON.parse(cleaned);

    // Support both old format (plain array) and new format ({results, suggestedFeatures})
    const rawResults: Array<{ featureId: string; detected: boolean }> = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.results)
        ? parsed.results
        : [];

    // Build a map of LLM results
    const llmResults = new Map<string, boolean>();
    for (const item of rawResults) {
      if (item.featureId && typeof item.detected === "boolean") {
        llmResults.set(item.featureId, item.detected);
      }
    }

    // Build complete results for all features (mark as not evaluated if
    // an ancestor was not detected — skip descendant evaluation)
    const results: PromptFeatureResult[] = features.map(f => ({
      featureId: f.id,
      detected: llmResults.get(f.id) ?? false,
      evaluated: llmResults.has(f.id),
    }));

    // Parse suggested features (sanitize IDs)
    const rawSuggestions: SuggestedPromptFeature[] = [];
    if (!Array.isArray(parsed) && Array.isArray(parsed.suggestedFeatures)) {
      for (const s of parsed.suggestedFeatures) {
        if (s.suggestedId && s.behavior && s.prompt) {
          const sanitizedId = String(s.suggestedId)
            .toLowerCase()
            .replace(/[^a-z0-9_]/g, "_")
            .replace(/^[^a-z]+/, "")
            .replace(/_+/g, "_")
            .replace(/_$/, "");
          rawSuggestions.push({
            suggestedId: sanitizedId || "asks_for_something",
            behavior: String(s.behavior).trim(),
            prompt: String(s.prompt).trim(),
          });
        }
      }
    }

    return { results, suggestedFeatures: rawSuggestions };
  } catch {
    throw new Error(`Failed to parse LLM extraction response as JSON: ${cleaned}`);
  }
}
