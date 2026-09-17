// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { expect, it } from "vitest";
import { validateCoverage } from "./validate-coverage.js";

it("covers every manifest family, variant, and red-team surface", async () => {
  await expect(validateCoverage()).resolves.toEqual({
    qualityTargets: 15,
    redTeamTargets: 8,
  });
});
