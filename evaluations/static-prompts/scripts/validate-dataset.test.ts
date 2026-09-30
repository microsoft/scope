// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { QUALITY_FAMILIES } from "./harvest.js";
import { validateDataset } from "./validate-dataset.js";

describe("validateDataset", () => {
  it("accepts the committed curated dataset and covers every family", async () => {
    const { cases, counts } = await validateDataset();
    expect(cases.length).toBeGreaterThan(0);
    for (const family of QUALITY_FAMILIES) {
      expect(counts[family]).toBeGreaterThan(0);
    }
  });

  it("contains only explicitly approved cases with stable provenance", async () => {
    const { cases } = await validateDataset();
    expect(cases.every((row) => row.review.status === "approved")).toBe(true);
    expect(cases.every((row) => /^[a-f0-9]{64}$/.test(row.provenance.sourceHash))).toBe(true);
    expect(cases.some((row) => row.provenance.kind === "integration")).toBe(true);
  });
});
