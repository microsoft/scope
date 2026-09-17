// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { isUnexpected } from "@azure-rest/ai-inference";
import { postAdaptiveChatCompletion } from "./adaptive-chat-completions.js";
import { acquireInferenceClient, isLlmAvailable as inferenceAvailable } from "./llm-token.js";

// ---------------------------------------------------------------------------
// Generate task prompt from a short description or create a variation
// ---------------------------------------------------------------------------

const GENERATE_SYSTEM_PROMPT = `You are an expert at writing benchmark task prompts for AI coding agents.

A task prompt is a detailed instruction given to a coding agent (like GitHub Copilot) that tells it what to build. Good task prompts are:
- Specific about what to create (e.g., "Create a REST API with Express.js that manages a todo list")
- Clear about requirements (e.g., "Include CRUD endpoints, input validation, and error handling")
- Technology-aware when appropriate (e.g., "Use TypeScript, Node.js, and PostgreSQL")
- Concise but complete — typically 1-4 sentences

Given a short description of what the user wants, write a complete, benchmark-quality task prompt. If no description is provided, invent a creative and interesting task that would be a good benchmark for a coding agent — vary the domain, technology, and complexity. Do NOT repeat tasks from the existing list.

Here are examples of good task prompts:
- "Create a Hello World Node.js/Express REST API"
- "Create a Python HTTP-triggered Azure Function. Include infrastructure as code for deploying to Azure and instructions for local testing with Azure Functions Core Tools."
- "Create a Snake game using React"
- "Build a CLI tool in Go that converts CSV files to JSON, supporting streaming for large files and custom column mapping via a config file."

Respond with ONLY a JSON object in this exact format (no markdown, no code fences):
{"taskPrompt": "your complete task prompt here"}`;

const VARIATION_SYSTEM_PROMPT = `You are an expert at writing benchmark task prompts for AI coding agents.

You are given an existing task prompt. Your job is to create a meaningful variation of it. A good variation:
- Preserves the core intent and complexity level
- Changes some aspects: technology stack, specific requirements, domain, or approach
- Remains a valid, self-contained task prompt
- Is different enough to test the agent in a new way

If the user provides guidance on how to vary it, follow that guidance. Otherwise, make creative but reasonable changes.

Respond with ONLY a JSON object in this exact format (no markdown, no code fences):
{"taskPrompt": "your varied task prompt here"}`;

export interface GenerateTaskPromptResult {
  taskPrompt: string;
}

export interface TaskPromptRequest {
  messages: [
    { role: "system"; content: string },
    { role: "user"; content: string },
  ];
  model: string;
  temperature: number;
  max_tokens: number;
}

export function isTaskPromptLlmAvailable(): boolean {
  return inferenceAvailable();
}

function buildGenerateUserMessage(description: string | undefined, existingPrompts: string[]): string {
  const parts: string[] = [];

  if (existingPrompts.length > 0) {
    parts.push("EXISTING TASK PROMPTS (for reference — avoid duplicating these):");
    for (const p of existingPrompts) {
      parts.push(`- ${p}`);
    }
    parts.push("");
  }

  if (description) {
    parts.push(`DESCRIPTION:\n${description}`);
  } else {
    parts.push("Generate a creative and interesting benchmark task prompt. Choose a different domain, technology, or problem type than the existing prompts.");
  }
  return parts.join("\n");
}

function buildVariationUserMessage(existingPrompt: string, guidance?: string): string {
  const parts: string[] = [];
  parts.push(`EXISTING TASK PROMPT:\n${existingPrompt}`);
  if (guidance) {
    parts.push(`\nVARIATION GUIDANCE:\n${guidance}`);
  }
  return parts.join("\n");
}

export function buildTaskPromptRequest(
  opts: { description?: string; existingPrompt?: string },
  existingPrompts: string[],
  model: string,
): TaskPromptRequest {
  const { description, existingPrompt } = opts;
  const isVariation = !!existingPrompt;
  return {
    messages: [
      {
        role: "system",
        content: isVariation
          ? VARIATION_SYSTEM_PROMPT
          : GENERATE_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: isVariation
          ? buildVariationUserMessage(existingPrompt, description)
          : buildGenerateUserMessage(description, existingPrompts),
      },
    ],
    model,
    temperature: 0.7,
    max_tokens: 1024,
  };
}

export function parseTaskPromptResponse(
  content: string,
): GenerateTaskPromptResult {
  const cleaned = content.replace(/```json\s*|```\s*/g, "").trim();
  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("taskPrompt" in parsed) ||
      typeof parsed.taskPrompt !== "string" ||
      parsed.taskPrompt.trim().length === 0
    ) {
      throw new Error("Missing required 'taskPrompt' field");
    }

    return {
      taskPrompt: parsed.taskPrompt.trim(),
    };
  } catch (err) {
    // If JSON parsing fails, try to use the raw content as the task prompt
    if (cleaned.length > 10 && !cleaned.startsWith("{")) {
      return { taskPrompt: cleaned };
    }
    throw new Error(`Failed to parse LLM response: ${(err as Error).message}\nRaw: ${cleaned}`);
  }
}

export async function generateTaskPrompt(
  opts: { description?: string; existingPrompt?: string },
  existingPrompts: string[] = [],
  model?: string,
): Promise<GenerateTaskPromptResult> {
  const { description, existingPrompt } = opts;

  const {
    client: llm,
    endpoint,
    model: foundryModel,
  } = await acquireInferenceClient();

  // Priority: explicit arg > key-specific (from Foundry blob) > env > default.
  const modelName = model || foundryModel || process.env.LLM_MODEL || "gpt-4.1";

  const request = buildTaskPromptRequest(
    { description, existingPrompt },
    existingPrompts,
    modelName,
  );

  const response = await postAdaptiveChatCompletion({
    endpoint,
    model: request.model,
    messages: request.messages,
    temperature: request.temperature,
    maxTokens: request.max_tokens,
    send: (body) => llm.path("/chat/completions").post({ body }),
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

  return parseTaskPromptResponse(content);
}
