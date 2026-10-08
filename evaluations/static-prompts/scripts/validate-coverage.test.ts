// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { expect, it } from "vitest";
import { validateCoverage } from "./validate-coverage.js";

it("covers every quality manifest family and variant", async () => {
  await expect(validateCoverage()).resolves.toEqual({
    qualityTargets: 16,
  });
});
