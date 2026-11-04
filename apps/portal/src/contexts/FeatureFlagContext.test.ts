// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { featureEnabledFailClosed } from "./FeatureFlagContext.js";

describe("featureEnabledFailClosed", () => {
  it("stays disabled while loading, missing, failed-empty, or explicitly off", () => {
    expect(featureEnabledFailClosed([], true, "taxonome")).toBe(false);
    expect(featureEnabledFailClosed([], false, "taxonome")).toBe(false);
    expect(
      featureEnabledFailClosed(
        [{ key: "taxonome", label: "Taxonome", enabled: false, updatedAt: "" }],
        false,
        "taxonome",
      ),
    ).toBe(false);
  });

  it("enables only an explicit on state", () => {
    expect(
      featureEnabledFailClosed(
        [{ key: "taxonome", label: "Taxonome", enabled: true, updatedAt: "" }],
        false,
        "taxonome",
      ),
    ).toBe(true);
  });
});
