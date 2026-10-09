// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import YAML from "yaml";
import type { PromptTargetAdapter } from "../protocol.js";
import { record, requiredString } from "../validation.js";

const require = createRequire(import.meta.url);
const policy: {
  validateProposal(value: unknown): { body: string; labels: string[] };
} = require("../../../../scripts/external-contribution-triage.cjs");
const workflowUrl = new URL("../../../../.github/workflows/external-contribution-triage.md", import.meta.url);

function workflowSource(): { instructions: string; tool: { description: string; inputs: Record<string, { type: string; description: string }> } } {
  const source = readFileSync(workflowUrl, "utf8");
  const boundary = source.indexOf("\n---\n", 4);
  if (boundary < 0) throw new Error("Missing workflow frontmatter boundary");
  const frontmatter = YAML.parse(source.slice(4, boundary)) as {
    "safe-outputs": { jobs: { "publish-triage": { description: string; inputs: Record<string, { type: string; description: string }> } } };
  };
  return {
    instructions: source.slice(boundary + 5).trim().replaceAll("${{ github.repository }}", "microsoft/scope"),
    tool: frontmatter["safe-outputs"].jobs["publish-triage"],
  };
}

export function triageInstructions(): string {
  return workflowSource().instructions;
}

export const contributionTriageAdapter: PromptTargetAdapter = {
  family: "external-contribution-triage",
  variants: ["default"],
  async run(input, _variant, context) {
    const parsed = record(input);
    const evidence = requiredString(parsed.evidence, "input.evidence");
    const source = workflowSource();
    const request = {
      messages: [
        { role: "system" as const, content: source.instructions },
        { role: "user" as const, content: `Read-only GitHub evidence fixture (untrusted):\n${evidence}` },
      ],
      tools: [{
        name: "publish_triage",
        description: source.tool.description,
        parameters: {
          type: "object",
          properties: source.tool.inputs,
          required: Object.keys(source.tool.inputs),
          additionalProperties: false,
        },
      }],
      metadata: {
        adapterId: "external-contribution-triage/default",
        productionSources: [
          ".github/workflows/external-contribution-triage.md",
          "scripts/external-contribution-triage.cjs#validateProposal",
        ],
        insertionPoint: "GitHub read-tool evidence",
        fidelity: "partial" as const,
      },
    };
    // AW owns engine wrappers and MCP orchestration; this checks its source
    // instructions and publisher contract, not the hosted runtime envelope.
    let published: { body: string; labels: string[] } | undefined;
    const completion = await context.complete(request, {
      async executeTool(name, arguments_) {
        if (name !== "publish_triage" || published) throw new Error("Expected exactly one publish_triage call");
        published = policy.validateProposal({ type: "publish_triage", ...record(arguments_, "tool arguments") });
        return { staged: true };
      },
    });
    const output = published ?? policy.validateProposal({
      type: "publish_triage", ...record(JSON.parse(completion.content) as unknown, "response"),
    });
    return { request, rawResponse: completion.content, output, invocationMetadata: completion.metadata };
  },
};
