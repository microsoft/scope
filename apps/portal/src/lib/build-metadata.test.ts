// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolvePortalBuildMetadata } from "./build-metadata";

const FIXED_BUILD_TIME = new Date("2026-11-03T20:00:00.000Z");

describe("resolvePortalBuildMetadata", () => {
  it("uses explicit validated build metadata", () => {
    expect(resolvePortalBuildMetadata({
      GIT_COMMIT: "1929129742fe9de3fc2e332ccd558e011b8dd71a",
      GIT_BRANCH: "feature/portal-metadata",
      BUILD_TIME: "2026-11-03T19:00:00Z",
    })).toEqual({
      commit: "1929129742fe9de3fc2e332ccd558e011b8dd71a",
      branch: "feature/portal-metadata",
      buildTime: "2026-11-03T19:00:00Z",
    });
  });

  it("uses safe fallbacks when Git metadata is absent", () => {
    expect(resolvePortalBuildMetadata({}, () => FIXED_BUILD_TIME)).toEqual({
      commit: "unknown",
      branch: "unknown",
      buildTime: FIXED_BUILD_TIME.toISOString(),
    });
  });

  it("rejects invalid and secret-like values before client embedding", () => {
    expect(resolvePortalBuildMetadata({
      GIT_COMMIT: "not-a-commit",
      GIT_BRANCH: "github_pat_do-not-embed",
      BUILD_TIME: "token=do-not-embed",
    }, () => FIXED_BUILD_TIME)).toEqual({
      commit: "unknown",
      branch: "unknown",
      buildTime: FIXED_BUILD_TIME.toISOString(),
    });
  });

  it("does not invoke Git from the Vite startup path", async () => {
    const viteConfigPath = fileURLToPath(new URL("../../vite.config.ts", import.meta.url));
    const viteConfig = await readFile(viteConfigPath, "utf8");

    expect(viteConfig).not.toContain("child_process");
    expect(viteConfig).not.toContain("execSync");
    expect(viteConfig).not.toContain("git rev-parse");
  });
});
