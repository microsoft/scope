// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_JUDGE_MODEL,
  resolveFeedbackModel,
  resolveJudgeModel,
} from "./model-config.js";

describe("Judge model configuration", () => {
  it("uses provider-resolved auto selection by default", () => {
    expect(DEFAULT_JUDGE_MODEL).toBe("auto");
    expect(resolveJudgeModel(undefined, {})).toBe("auto");
    expect(resolveFeedbackModel(undefined, {})).toBe("auto");
  });

  it("preserves explicit constructor and environment precedence", () => {
    const env = {
      JUDGE_MODEL: "judge-env",
      FEEDBACK_MODEL: "feedback-env",
    };

    expect(resolveJudgeModel(undefined, env)).toBe("judge-env");
    expect(resolveFeedbackModel(undefined, env)).toBe("feedback-env");
    expect(resolveJudgeModel("judge-explicit", env)).toBe("judge-explicit");
    expect(resolveFeedbackModel("feedback-explicit", env)).toBe(
      "feedback-explicit",
    );
  });
});
