// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_REPORT_MODEL,
  resolveReportModel,
} from "./report-config.js";

describe("report generator model configuration", () => {
  it("uses provider-resolved auto selection by default", () => {
    expect(DEFAULT_REPORT_MODEL).toBe("auto");
    expect(resolveReportModel({})).toBe("auto");
  });

  it("preserves an explicit REPORT_MODEL override", () => {
    expect(resolveReportModel({ REPORT_MODEL: "configured-model" })).toBe(
      "configured-model",
    );
  });
});
