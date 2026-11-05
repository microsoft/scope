// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { normalizeCliArguments } from "./index.js";

describe("Taxonome CLI argv normalization", () => {
  it("removes pnpm's forwarded-option separator and preserves ordinary argv", () => {
    expect(normalizeCliArguments([
      "node",
      "taxonome",
      "eval",
      "--",
      "--element",
      "beh-timeout",
    ])).toEqual([
      "node",
      "taxonome",
      "eval",
      "--element",
      "beh-timeout",
    ]);
    expect(normalizeCliArguments(["node", "taxonome", "eval", "--json"]))
      .toEqual(["node", "taxonome", "eval", "--json"]);
  });
});
