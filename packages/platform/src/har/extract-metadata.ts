// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * HAR metadata extraction — extracts tool calls, token usage, and AI call
 * counts from a parsed HAR file and logs a summary.
 */

import { extractToolCalls, extractTokenUsage, extractAiCallCount } from "./har-parser.js";
import type { HarFile } from "./types.js";
import type { TokenUsage, WorkerLogFn } from "@scope/core";

/** Result of extracting metadata from a HAR capture. */
export interface HarCollectionResult {
  harFilePath: string | null;
  tokenUsage?: TokenUsage;
  aiCallCount?: number;
}

/**
 * Extract tool calls, token usage, and AI call count from a HAR file,
 * logging a summary via the provided log function.
 */
export async function extractHarMetadata(
  har: HarFile,
  harFilePath: string | null,
  log: WorkerLogFn,
): Promise<HarCollectionResult> {
  const toolCalls = extractToolCalls(har);
  await log("info", `Extracted ${toolCalls.length} tool calls from HAR`, {
    toolCallCount: toolCalls.length,
    toolNames: toolCalls.map((tc) => tc.name),
  });
  const tokenUsage = extractTokenUsage(har) ?? undefined;
  if (tokenUsage) {
    await log("info", `Token usage: ${tokenUsage.promptTokens} prompt, ${tokenUsage.completionTokens} completion, ${tokenUsage.totalTokens} total`);
  }
  const aiCallCount = extractAiCallCount(har);
  await log("info", `AI call count: ${aiCallCount}`);
  return { harFilePath, tokenUsage, aiCallCount };
}
