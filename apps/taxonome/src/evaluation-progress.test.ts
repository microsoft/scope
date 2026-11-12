// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import {
  elementProgressLabel,
} from "./evaluation-progress.js";

const prompt = {
  id: "beh-prompt",
  label: "Prompt Behavior",
  implementation: "prompt" as const,
};
const deterministic = {
  id: "beh-code",
  label: "Code Behavior",
  implementation: "deterministic" as const,
};

describe("evaluation progress formatting", () => {
  it("labels prompt and code elements with model-call behavior", () => {
    expect(elementProgressLabel(prompt)).toContain("Prompt");
    expect(elementProgressLabel(prompt)).toContain("model calls possible");
    expect(elementProgressLabel(deterministic)).toContain("Code/Deterministic");
    expect(elementProgressLabel(deterministic)).toContain("no model calls");
  });

});
