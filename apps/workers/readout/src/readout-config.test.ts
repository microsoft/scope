// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_READOUT_MODEL,
  resolveReadoutModel,
} from "./readout-config.js";

describe("readout model configuration", () => {
  it("uses provider-resolved auto selection by default", () => {
    expect(DEFAULT_READOUT_MODEL).toBe("auto");
    expect(resolveReadoutModel({})).toBe("auto");
  });

  it("preserves an explicit READOUT_MODEL override", () => {
    expect(resolveReadoutModel({ READOUT_MODEL: "configured-model" })).toBe(
      "configured-model",
    );
  });
});
