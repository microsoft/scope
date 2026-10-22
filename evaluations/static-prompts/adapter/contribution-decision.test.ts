// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDecisionInput,
  DECISION_QUESTIONS,
  parseDecisionResponse,
  type DecisionInput,
} from "../../../scripts/contribution-insights/decision.mjs";
import { contributionDecisionFixture } from "../scripts/contribution-decision-fixtures.js";
import { CONTRIBUTION_FIXTURES } from "../scripts/contribution-insights-fixtures.js";
import { composeContributionDecisionRequest, contributionDecisionAdapter } from "./targets/contribution-decision.js";
import { createFakeAdapterContext, createProductionAdapterContext } from "./transport.js";
import { AdapterTransportError } from "./validation.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function fixtureInput(id: (typeof CONTRIBUTION_FIXTURES)[number]["id"] = "docs-only") {
  const { snapshot, assessment } = contributionDecisionFixture(id);
  return { snapshot: JSON.stringify(snapshot), assessment };
}

function decisionInput(): DecisionInput {
  const { snapshot, assessment } = contributionDecisionFixture("docs-only");
  return buildDecisionInput(snapshot.contributions[0], assessment);
}

describe("production-backed contribution decision composition", () => {
  it("retains the real state/questions request and marks chat messages as a partial grader projection", async () => {
    const input = fixtureInput("product-decision");
    const { snapshot, assessment } = contributionDecisionFixture("product-decision");
    const request = await composeContributionDecisionRequest(input);
    const production = buildDecisionInput(snapshot.contributions[0], assessment);

    expect(request.decisionRequest).toEqual(production);
    expect(request.decisionRequest?.questions).toBe(DECISION_QUESTIONS);
    expect(request.decisionRequest?.state.copilotInsights).toEqual(assessment);
    expect(request.messages).toEqual([
      { role: "system", content: JSON.stringify(production.questions) },
      { role: "user", content: JSON.stringify(production.state) },
    ]);
    expect(request.metadata).toMatchObject({
      adapterId: "contribution-decision/default",
      fidelity: "partial",
      productionSources: expect.arrayContaining(["scripts/contribution-insights/decision.mts"]),
    });
    expect(request.tools).toBeUndefined();
    expect(request.model).toBe("microsoft-decision-1");
    expect(request.decisionRequest?.state.copilotInsights).not.toHaveProperty("recommendation");
    expect(request.decisionRequest?.state.copilotInsights).not.toHaveProperty("decision");
  });

  it("never sends the request through chat completion and preserves the service's actual response", async () => {
    const fake = createFakeAdapterContext();
    const complete = vi.fn().mockRejectedValue(new Error("Chat completion must not run"));
    const decide = vi.fn(fake.decide!);
    const result = await contributionDecisionAdapter.run(fixtureInput(), "default", {
      model: "not-the-decision-deployment", complete, decide,
    });

    expect(complete).not.toHaveBeenCalled();
    expect(decide).toHaveBeenCalledExactlyOnceWith(result.request.decisionRequest);
    const raw: unknown = JSON.parse(result.rawResponse);
    expect(raw).toMatchObject({ fake: true });
    expect(result.invocationMetadata?.source).toBe("fake");
    expect(result.output.decision).toMatchObject({
      ...parseDecisionResponse(raw),
      status: "completed", provider: "Microsoft-Decision-1", action: "manual-review-required",
    });
  });

  it("requires a separate typed transport instead of falling back to Copilot", async () => {
    const complete = vi.fn();
    await expect(contributionDecisionAdapter.run(fixtureInput(), "default", {
      model: "copilot", complete,
    })).rejects.toThrow("separate Microsoft-Decision-1 transport");
    expect(complete).not.toHaveBeenCalled();
  });

  it("does not reinterpret or rewrite the typed transport's raw diagnostics", async () => {
    const context = createFakeAdapterContext();
    const completion = await context.decide!(decisionInput());
    const result = await contributionDecisionAdapter.run(fixtureInput(), "default", {
      ...context,
      async decide() { return { ...completion, rawResponse: "Unmodified transport diagnostics." }; },
    });
    expect(result.rawResponse).toBe("Unmodified transport diagnostics.");
    expect(result.output.decision).toEqual(completion.decision);
  });

  it("prevents either transport's chat method from accepting a Decision-1 request", async () => {
    const request = await composeContributionDecisionRequest(fixtureInput());
    await expect(createProductionAdapterContext().complete(request)).rejects.toThrow("never chat completions");
    await expect(createFakeAdapterContext().complete(request)).rejects.toThrow("never chat completions");
  });

  it.each(["recommendation", "decision"])("rejects a Copilot-supplied %s before requesting a decision", async (field) => {
    const input = fixtureInput();
    await expect(composeContributionDecisionRequest({
      ...input, assessment: { ...input.assessment, [field]: "prioritize-review" },
    })).rejects.toThrow("insights only");
  });

  it("rejects stale or ambiguous PR-to-insight bindings", async () => {
    const input = fixtureInput();
    await expect(composeContributionDecisionRequest({
      ...input, assessment: { ...input.assessment, headSha: "d".repeat(40) },
    })).rejects.toThrow("stale head SHA");
    const { snapshot, assessment } = contributionDecisionFixture("docs-only");
    snapshot.contributions.push({ ...snapshot.contributions[0], number: 43 });
    await expect(composeContributionDecisionRequest({
      snapshot: JSON.stringify(snapshot), assessment,
    })).rejects.toThrow("exactly one");
  });

  it("uses fixed fake abstention for every fixture, independent of reviewed expected labels", async () => {
    const context = createFakeAdapterContext();
    for (const fixture of CONTRIBUTION_FIXTURES) {
      const result = await contributionDecisionAdapter.run(fixtureInput(fixture.id), "default", context);
      expect(result.output.decision.action).toBe("manual-review-required");
      const raw: unknown = JSON.parse(result.rawResponse);
      expect(raw).toMatchObject({ fake: true, note: expect.stringContaining("not a Microsoft-Decision-1 inference") });
      expect(parseDecisionResponse(raw).action).toBe("manual-review-required");
      expect(result.output.decision.inputSha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});

describe("dedicated Decision-1 production transport", () => {
  it("fails closed without explicit Decision-1 configuration and makes no inference request", async () => {
    for (const key of [
      "CONTRIBUTION_DECISION_ENABLED", "CONTRIBUTION_DECISION_ENDPOINT", "CONTRIBUTION_DECISION_DEPLOYMENT",
      "CONTRIBUTION_DECISION_API_KEY", "CONTRIBUTION_DECISION_ENTRA_TOKEN",
    ]) vi.stubEnv(key, "");
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const context = createProductionAdapterContext("a-chat-deployment-is-not-a-fallback");
    const completion = context.decide!(decisionInput());
    await expect(completion).rejects.toThrow("CONTRIBUTION_DECISION_ENDPOINT");
    await expect(completion).rejects.toBeInstanceOf(AdapterTransportError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("classifies a failed Decision-1 connection as infrastructure without trying a chat fallback", async () => {
    vi.stubEnv("CONTRIBUTION_DECISION_ENDPOINT", "https://decision-eval.services.ai.azure.com");
    vi.stubEnv("CONTRIBUTION_DECISION_DEPLOYMENT", "configured-decision-deployment");
    vi.stubEnv("CONTRIBUTION_DECISION_API_KEY", "unit-test-not-a-real-key");
    vi.stubEnv("CONTRIBUTION_DECISION_ENTRA_TOKEN", "");
    vi.stubEnv("CONTRIBUTION_DECISION_ENABLED", "true");
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetcher);
    await expect(createProductionAdapterContext().decide!(decisionInput())).rejects.toBeInstanceOf(AdapterTransportError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("posts native state/questions to the configured Foundry deployment, not chat completions", async () => {
    vi.stubEnv("CONTRIBUTION_DECISION_ENABLED", "true");
    vi.stubEnv("CONTRIBUTION_DECISION_ENDPOINT", "https://decision-eval.services.ai.azure.com");
    vi.stubEnv("CONTRIBUTION_DECISION_DEPLOYMENT", "configured-decision-deployment");
    vi.stubEnv("CONTRIBUTION_DECISION_API_KEY", "unit-test-not-a-real-key");
    vi.stubEnv("CONTRIBUTION_DECISION_ENTRA_TOKEN", "");
    const rawResponse = JSON.stringify({
      model: "microsoft-decision-1",
      answers: { review_action: {
        type: "choice", choice: "request-clarification", confidence: 0.61,
        probabilities: {
          "prioritize-review": 0.1, "request-clarification": 0.7, "request-contributor-changes": 0.1,
          "maintainer-scope-decision": 0.05, "manual-review-required": 0.05,
        },
      } },
      usage: { input_tokens: 123, output_tokens: 9 },
    }, null, 2);
    const fetcher = vi.fn<typeof fetch>(async () => new Response(rawResponse));
    vi.stubGlobal("fetch", fetcher);
    const input = decisionInput();
    const result = await createProductionAdapterContext("unused-chat-model").decide!(input);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      "https://decision-eval.services.ai.azure.com/providers/microsoft/v1/systemone",
      expect.objectContaining({ method: "POST" }),
    );
    const options = fetcher.mock.calls[0][1];
    const body: unknown = JSON.parse(String(options?.body));
    expect(body).toEqual({ model: "configured-decision-deployment", ...input });
    expect(body).not.toHaveProperty("messages");
    expect(result.rawResponse).toBe(rawResponse);
    expect(result.decision).toMatchObject({
      status: "completed", action: "request-clarification", model: "microsoft-decision-1",
      inputTokens: 123, outputTokens: 9, confidence: 0.61,
    });
    expect(result.decision.probabilities["request-clarification"]).toBe(0.7);
  });
});
