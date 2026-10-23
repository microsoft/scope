// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import {
  parseTaxonomyJsonSchema,
  validateTaxonomyJson,
} from "./json-schema.js";

describe("taxonomy JSON Schema subset", () => {
  it("rejects non-finite JavaScript numbers that cannot survive JSON encoding", () => {
    const schema = parseTaxonomyJsonSchema({ type: "number" });

    expect(validateTaxonomyJson(schema, Number.NaN)).toEqual([
      "$ must be a finite JSON number",
    ]);
    expect(validateTaxonomyJson(schema, Number.POSITIVE_INFINITY)).toEqual([
      "$ must be a finite JSON number",
    ]);
    expect(validateTaxonomyJson(schema, Number.NEGATIVE_INFINITY)).toEqual([
      "$ must be a finite JSON number",
    ]);
  });
});
