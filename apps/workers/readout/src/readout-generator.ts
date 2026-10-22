// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { CopilotClient, type PermissionHandler, SessionEvent } from "@github/copilot-sdk";
import type { LogEvent } from "shared";
import {
  composeExperimentReadout,
  readoutSynthesisSchema,
  type ExperimentEvidence,
} from "./readout-builder.js";
import {
  READOUT_SYSTEM_PROMPT,
  composeReadoutUserPrompt,
} from "./prompt.js";

const approveNoTools: PermissionHandler = () => ({
  kind: "denied-by-rules",
  rules: [],
});

type ReadoutLog = (
  level: LogEvent["level"],
  message: string,
  data?: Record<string, unknown>,
) => Promise<void> | void;

export async function generateExperimentReadout(input: {
  evidence: ExperimentEvidence;
  model: string;
  githubToken: string;
  timeoutMs: number;
  log: ReadoutLog;
}) {
  const client = new CopilotClient({ gitHubToken: input.githubToken });
  let latestMessage = "";
  let streamedResponse = "";
  try {
    const session = await client.createSession({
      model: input.model,
      streaming: true,
      availableTools: [],
      excludedTools: ["builtin:*", "mcp:*"],
      onPermissionRequest: approveNoTools,
      systemMessage: { mode: "replace", content: READOUT_SYSTEM_PROMPT },
    });
    session.on((event: SessionEvent) => {
      if (event.type === "assistant.message_delta") {
        streamedResponse += event.data.deltaContent;
      } else if (event.type === "assistant.message") {
        latestMessage = event.data.content;
      } else if (event.type === "session.error") {
        void input.log("error", event.data.message, {
          errorType: event.data.errorType,
        });
      }
    });

    let prompt = composeReadoutUserPrompt(input.evidence);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      streamedResponse = "";
      latestMessage = "";
      await input.log("info", `Generating Experiment readout (${attempt}/3)`);
      const response = await session.sendAndWait({ prompt }, input.timeoutMs);
      const text =
        response?.data.content?.trim() ||
        latestMessage.trim() ||
        streamedResponse.trim();
      if (!text) throw new Error("Copilot SDK returned an empty readout response");
      const jsonText = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonText) as unknown;
      } catch (error) {
        if (attempt === 3) {
          throw new Error(`Readout response was not valid JSON: ${String(error)}`);
        }
        prompt = "Return the complete corrected readout synthesis as raw JSON only.";
        continue;
      }
      const result = readoutSynthesisSchema.safeParse(parsed);
      if (result.success) {
        return composeExperimentReadout(input.evidence, result.data);
      }
      if (attempt === 3) {
        throw new Error(
          `Readout synthesis failed schema validation: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
        );
      }
      prompt = [
        "Return the complete corrected readout synthesis as raw JSON only.",
        `Validation errors: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
      ].join("\n");
    }
    throw new Error("Readout generation ended without a valid result");
  } finally {
    await client.stop().catch(async (error: unknown) => {
      await input.log("warn", "Failed to stop Copilot SDK client cleanly", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
