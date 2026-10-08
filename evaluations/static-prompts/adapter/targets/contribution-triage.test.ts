// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { contributionTriageAdapter, triageInstructions } from "./contribution-triage.js";
import { triageCases } from "../../scripts/triage-cases.js";

describe("contribution triage composition", () => {
  it("uses the production workflow body and tool contract without a copied prompt", async () => {
    const source = readFileSync(new URL("../../../../.github/workflows/external-contribution-triage.md", import.meta.url), "utf8");
    const boundary = source.indexOf("\n---\n", 4);
    const frontmatter = YAML.parse(source.slice(4, boundary)) as {
      "safe-outputs": { jobs: { "publish-triage": { description: string; inputs: unknown } } };
    };
    expect(triageInstructions()).toBe(source.slice(boundary + 5).trim().replaceAll("${{ github.repository }}", "microsoft/scope"));
    const result = await contributionTriageAdapter.run(triageCases()[0].input, "default", {
      model: "fake",
      async complete(request, options) {
        expect(request.messages[0].content).toBe(triageInstructions());
        expect(request.messages[1].content).toContain("untrusted");
        expect(request.tools?.[0].description).toBe(frontmatter["safe-outputs"].jobs["publish-triage"].description);
        expect(request.tools?.[0].parameters).toMatchObject({
          properties: frontmatter["safe-outputs"].jobs["publish-triage"].inputs,
          additionalProperties: false,
        });
        await options?.executeTool?.("publish_triage", { body: "Evidence-backed advisory findings for the CLI.", labels: '["area: cli"]' });
        return { content: "Preview generated." };
      },
    });
    expect(result.output).toEqual({ body: "Evidence-backed advisory findings for the CLI.", labels: ["area: cli"] });
    expect(result.request.metadata.fidelity).toBe("partial");
  });
  it("keeps all curated cases in the generated integrity dataset", () => {
    const text = readFileSync(new URL("../../datasets/v1/contribution-triage.jsonl", import.meta.url), "utf8");
    expect(text).toBe(triageCases().map((row) => JSON.stringify(row)).join("\n") + "\n");
  });
  it("rejects unknown tools or multiple publications", async () => {
    await expect(contributionTriageAdapter.run(triageCases()[0].input, "default", {
      model: "fake",
      async complete(_request, options) {
        await options?.executeTool?.("approve_pull_request", {});
        return { content: "" };
      },
    })).rejects.toThrow("exactly one");
  });
});
