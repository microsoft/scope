// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { PORTAL_AI_NOT_CONFIGURED_ERROR } from "./portal-ai-copy.js";

describe("Portal AI fallback copy", () => {
  it("recommends Copilot SDK and identifies GitHub Models as legacy", () => {
    expect(PORTAL_AI_NOT_CONFIGURED_ERROR).toContain(
      "GitHub token with Copilot SDK capability",
    );
    expect(PORTAL_AI_NOT_CONFIGURED_ERROR).toContain(
      "legacy GitHub Models key",
    );
  });
});
