// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { CopilotClient, type PermissionHandler, SessionEvent } from "@github/copilot-sdk";
import {
  type LogEvent,
  taxonomySchema,
  type TaxonomyDocument,
} from "shared";
import { TAXONOMY_SYSTEM_PROMPT } from "./prompt.js";
import { createTaxonomyTools } from "./tools.js";

export const DEFAULT_SESSION_TIMEOUT_MS = 5 * 60 * 1000;
const DELTA_LOG_INTERVAL = 2_000;
const approveTaxonomyTools: PermissionHandler = request =>
  request.kind === "custom-tool"
    ? { kind: "approved" }
    : { kind: "denied-by-rules", rules: [] };

type TaxonomyLogFn = (
  level: LogEvent["level"],
  msg: string,
  data?: Record<string, unknown>,
) => Promise<void> | void;

export interface GenerateTaxonomyParams {
  requestId: string;
  runId: string;
  apiBaseUrl: string;
  taxonomyModel: string;
  githubToken: string;
  sessionTimeoutMs?: number;
  log: TaxonomyLogFn;
  /** Optional raw session-event hook (used by the dev CLI to render live progress). */
  onEvent?: (event: SessionEvent) => void;
}

/**
 * Runs the Copilot SDK taxonomy generation loop and returns a schema-validated
 * taxonomy document. This is side-effect-free with respect to Mongo and blob
 * storage (it only reads run data and ATIF trajectories through the API);
 * persistence is the caller's responsibility.
 */
export async function generateTaxonomy(params: GenerateTaxonomyParams): Promise<TaxonomyDocument> {
  const { requestId, runId, apiBaseUrl, taxonomyModel, githubToken, log, onEvent } = params;
  const client = new CopilotClient({ githubToken });
  const tools = createTaxonomyTools(apiBaseUrl, requestId);
  const timeoutMs = params.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;

  let streamedResponse = "";
  let latestMessage = "";
  let lastLoggedCharCount = 0;
  const toolNames = new Map<string, string>();

  try {
    const session = await client.createSession({
      model: taxonomyModel,
      streaming: true,
      tools,
      availableTools: [],
      excludedTools: ["builtin:*", "mcp:*"],
      onPermissionRequest: approveTaxonomyTools,
      systemMessage: { mode: "replace", content: TAXONOMY_SYSTEM_PROMPT },
    });

    session.on((event: SessionEvent) => {
      onEvent?.(event);
      switch (event.type) {
        case "session.start":
          void log("info", "Copilot session started", {
            sessionId: event.data.sessionId,
            model: event.data.selectedModel,
          });
          break;
        case "session.error":
          void log("error", `Session error: ${event.data.message}`, { errorType: event.data.errorType });
          break;
        case "tool.execution_start":
          toolNames.set(event.data.toolCallId, event.data.toolName);
          void log("info", `Tool call: ${event.data.toolName}`, {
            toolCallId: event.data.toolCallId,
            arguments: event.data.arguments as Record<string, unknown> | undefined,
          });
          break;
        case "tool.execution_complete": {
          const toolName = toolNames.get(event.data.toolCallId) ?? "unknown";
          toolNames.delete(event.data.toolCallId);
          void log("info", `Tool result: ${toolName} (${event.data.success ? "success" : "failed"})`, {
            toolCallId: event.data.toolCallId,
            error: event.data.error?.message,
          });
          break;
        }
        case "assistant.message_delta":
          streamedResponse += event.data.deltaContent;
          if (streamedResponse.length - lastLoggedCharCount >= DELTA_LOG_INTERVAL) {
            lastLoggedCharCount = streamedResponse.length;
            void log("info", `Generating taxonomy… (${streamedResponse.length} chars so far)`);
          }
          break;
        case "assistant.message":
          latestMessage = event.data.content;
          break;
      }
    });

    let attempts = 0;
    const maxAttempts = 3;
    let prompt = [
      `Generate taxonomy JSON for request ${requestId} and run ${runId}.`,
      "Use get_run_data first, then inspect ATIF trajectories that materially affect the classification.",
      "Return only raw JSON that satisfies the taxonomy schema.",
    ].join(" ");
    let lastJson: string | undefined;

    while (attempts < maxAttempts) {
      attempts += 1;
      streamedResponse = "";
      latestMessage = "";
      lastLoggedCharCount = 0;

      await log("info", `Sending taxonomy prompt to Copilot SDK (attempt ${attempts}/${maxAttempts})`, {
        requestId,
        runId,
        timeoutMs,
      });

      const response = await session.sendAndWait({ prompt }, timeoutMs);
      const responseText = response?.data.content?.trim() || latestMessage.trim() || streamedResponse.trim();

      if (!responseText) {
        throw new Error("Copilot SDK returned an empty taxonomy response");
      }

      const jsonText = extractJson(responseText);
      lastJson = jsonText;

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(jsonText) as unknown;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (attempts >= maxAttempts) {
          throw new Error(`Taxonomy response was not valid JSON after ${maxAttempts} attempts: ${errorMessage}`);
        }

        prompt = [
          "Your previous response was not valid JSON.",
          `JSON parse error: ${errorMessage}.`,
          "Return the full taxonomy document again as raw JSON only, with no markdown fences or commentary.",
          "Replace the entire response with corrected JSON.",
        ].join(" ");
        continue;
      }

      const validation = taxonomySchema.safeParse(parsedJson);
      if (validation.success) {
        return validation.data;
      }

      const validationErrors = formatValidationErrors(validation.error.issues);
      await log("warn", `Taxonomy validation failed on attempt ${attempts}`, {
        issues: validationErrors,
      });

      if (attempts >= maxAttempts) {
        throw new Error(
          `Taxonomy schema validation failed after ${maxAttempts} attempts: ${validationErrors.join(" | ")}`,
        );
      }

      prompt = [
        "Your previous taxonomy JSON did not satisfy the schema.",
        "Correct the document and return the entire replacement JSON object.",
        "Do not include markdown fences or commentary.",
        `Validation errors: ${validationErrors.join("; ")}`,
        lastJson ? `Previous JSON: ${lastJson}` : "",
      ].filter(Boolean).join(" ");
    }

    throw new Error("Taxonomy generation ended without a valid document");
  } finally {
    await client.stop().catch(() => undefined);
  }
}

function extractJson(responseText: string): string {
  const trimmed = responseText.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }

  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch?.[1]?.trim() ?? trimmed;
}

function formatValidationErrors(issues: Array<{ path: PropertyKey[]; message: string }>): string[] {
  return issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map((segment) => String(segment)).join(".") : "<root>";
    return `${path}: ${issue.message}`;
  });
}
