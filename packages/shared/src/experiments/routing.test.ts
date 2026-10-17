// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import {
  assignExperimentRequestBucket,
  computeExperimentChunkId,
} from "./routing.js";

describe("experiment routing", () => {
  it("matches the sha256-mod-v1 golden assignment", () => {
    expect(assignExperimentRequestBucket("request-123", 17)).toBe(15);
    expect(assignExperimentRequestBucket("request-123", 17)).toBe(15);
  });

  it("matches the deterministic canonical tuple chunk id", () => {
    expect(
      computeExperimentChunkId({
        projectId: "p",
        experimentId: "e",
        kind: "requests",
        ownerId: "x",
        generation: 2,
        chunkIndex: 3,
      }),
    ).toBe("ec_v1_nFlNA4koLtvQvUwoexRibIpfKx89eMnNfsFCPFXfIkU");
  });

  it("rejects invalid bucket counts", () => {
    expect(() => assignExperimentRequestBucket("request-1", 0)).toThrow(
      /positive safe integer/,
    );
  });
});
