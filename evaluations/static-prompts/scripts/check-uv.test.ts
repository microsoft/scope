// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { checkUv, uvInstallGuidance } from "./check-uv.js";

describe("uv prerequisite check", () => {
  it("accepts an available uv executable", () => {
    expect(
      checkUv(() => ({
        status: 0,
      })),
    ).toBe(true);
  });

  it("rejects a missing uv executable", () => {
    expect(
      checkUv(() => ({
        error: Object.assign(new Error("not found"), { code: "ENOENT" }),
        status: null,
      })),
    ).toBe(false);
  });

  it("provides official platform-specific installation guidance", () => {
    expect(uvInstallGuidance("darwin")).toContain("brew install uv");
    expect(uvInstallGuidance("linux")).toContain("astral.sh/uv/install.sh");
    expect(uvInstallGuidance("win32")).toContain("winget install");
    expect(uvInstallGuidance("linux")).toContain(
      "https://docs.astral.sh/uv/getting-started/installation/",
    );
  });
});
