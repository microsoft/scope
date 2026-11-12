// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import {
  PortableTaxonomySchema,
  TaxonomyRevisionRefSchema,
} from "../schemas/taxonomy.js";
import { taxonomyContentSha256 } from "./taxonomy-revision-store.js";

const taxonomy = {
  schema_version: "scope/taxonomy/v1" as const,
  id: "example",
  version: "1.0.0",
  surfaces: [],
  elements: [{ ref: "element-a@r1" }],
};

describe("taxonomy contracts", () => {
  it("requires canonical exact revision refs", () => {
    expect(TaxonomyRevisionRefSchema.parse("element-a@r12")).toBe(
      "element-a@r12",
    );
    for (const invalid of ["element-a", "element-a@latest", "@r1", "a@r0"]) {
      expect(() => TaxonomyRevisionRefSchema.parse(invalid)).toThrow();
    }
  });

  it("rejects ambiguous and unsafe element references", () => {
    for (const element of [
      { path: "../element.yaml" },
      { path: "/tmp/element.yaml" },
      { path: "element.yaml", ref: "element-a@r1" },
      {},
    ]) {
      expect(() =>
        PortableTaxonomySchema.parse({ ...taxonomy, elements: [element] }),
      ).toThrow();
    }
  });

  it("hashes semantic content independently of object key order", () => {
    const reordered = {
      version: "1.0.0",
      id: "example",
      elements: [{ ref: "element-a@r1" }],
      surfaces: [],
      schema_version: "scope/taxonomy/v1" as const,
    };
    expect(taxonomyContentSha256(taxonomy)).toBe(
      taxonomyContentSha256(reordered),
    );
  });
});
