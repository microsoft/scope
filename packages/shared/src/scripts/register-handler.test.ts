// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { parseHandlerDocument } from "./register-handler.js";

describe("parseHandlerDocument", () => {
  const valid = {
    _id: "pp-taxonomy",
    type: "post-process-handler",
    version: 1,
    queue: "pp-taxonomy-queue",
    selector: "taxonomy",
    autoBackfill: false,
    dependsOn: ["pp-atif"],
  };

  it("accepts a valid handler document", () => {
    expect(parseHandlerDocument(valid)).toEqual(valid);
  });

  it("defaults dependsOn to an empty array when omitted", () => {
    const { dependsOn, ...withoutDeps } = valid;
    expect(parseHandlerDocument(withoutDeps).dependsOn).toEqual([]);
  });

  it("rejects a missing _id", () => {
    expect(() => parseHandlerDocument({ ...valid, _id: "" })).toThrow(/_id/);
  });

  it("rejects a wrong type", () => {
    expect(() => parseHandlerDocument({ ...valid, type: "agent" })).toThrow(/type/);
  });

  it("rejects a non-numeric version", () => {
    expect(() => parseHandlerDocument({ ...valid, version: "1" })).toThrow(/version/);
  });

  it("rejects a non-boolean autoBackfill", () => {
    expect(() => parseHandlerDocument({ ...valid, autoBackfill: "yes" })).toThrow(
      /autoBackfill/,
    );
  });

  it("rejects a dependsOn that is not an array of strings", () => {
    expect(() => parseHandlerDocument({ ...valid, dependsOn: [1, 2] })).toThrow(
      /dependsOn/,
    );
  });

  it("rejects a non-object input", () => {
    expect(() => parseHandlerDocument("nope")).toThrow(/mapping/);
  });
});
