// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, vi } from "vitest";
import {
  resolvePortalBuildMetadata,
  type PortalGitMetadataReader,
} from "./build-metadata";

const FIXED_BUILD_TIME = new Date("2026-11-03T20:00:00.000Z");

describe("resolvePortalBuildMetadata", () => {
  it("gives explicit validated metadata precedence when Git lookup is enabled", () => {
    const gitMetadata = reader("aaaaaaaa", "git-branch");

    expect(resolvePortalBuildMetadata({
      GIT_COMMIT: "1929129742fe9de3fc2e332ccd558e011b8dd71a",
      GIT_BRANCH: "feature/portal-metadata",
      BUILD_TIME: "2026-11-03T19:00:00Z",
    }, gitMetadata)).toEqual({
      commit: "1929129742fe9de3fc2e332ccd558e011b8dd71a",
      branch: "feature/portal-metadata",
      buildTime: "2026-11-03T19:00:00Z",
    });

    expect(gitMetadata.readCommit).not.toHaveBeenCalled();
    expect(gitMetadata.readBranch).not.toHaveBeenCalled();
  });

  it("falls back to Git when explicit metadata is absent", () => {
    expect(resolvePortalBuildMetadata({}, reader(
      "1929129742fe9de3fc2e332ccd558e011b8dd71a",
      "feature/from-git",
    ), () => FIXED_BUILD_TIME)).toEqual({
      commit: "1929129742fe9de3fc2e332ccd558e011b8dd71a",
      branch: "feature/from-git",
      buildTime: FIXED_BUILD_TIME.toISOString(),
    });
  });

  it("keeps Git enabled for values other than the exact false sentinel", () => {
    expect(resolvePortalBuildMetadata({
      PORTAL_GIT_INFO_ENABLED: "False",
    }, reader("abcdef1234567", "feature/from-git"), () => FIXED_BUILD_TIME))
      .toMatchObject({
        commit: "abcdef1234567",
        branch: "feature/from-git",
      });
  });

  it("skips Git and uses development placeholders when explicitly disabled", () => {
    const gitMetadata = reader("aaaaaaaa", "git-branch");

    expect(resolvePortalBuildMetadata({
      PORTAL_GIT_INFO_ENABLED: "false",
      GIT_COMMIT: "bbbbbbbb",
      GIT_BRANCH: "explicit-branch",
    }, gitMetadata, () => FIXED_BUILD_TIME)).toEqual({
      commit: "development",
      branch: "",
      buildTime: FIXED_BUILD_TIME.toISOString(),
    });

    expect(gitMetadata.readCommit).not.toHaveBeenCalled();
    expect(gitMetadata.readBranch).not.toHaveBeenCalled();
  });

  it("falls back through invalid values and Git command failures", () => {
    expect(resolvePortalBuildMetadata({
      GIT_COMMIT: "not-a-commit",
      GIT_BRANCH: "github_pat_do-not-embed",
      BUILD_TIME: "token=do-not-embed",
    }, reader(undefined, undefined), () => FIXED_BUILD_TIME)).toEqual({
      commit: "development",
      branch: "",
      buildTime: FIXED_BUILD_TIME.toISOString(),
    });
  });

  it("uses Git after rejecting invalid explicit values", () => {
    expect(resolvePortalBuildMetadata({
      GIT_COMMIT: "not-a-commit",
      GIT_BRANCH: "feature//invalid",
    }, reader("abcdef1234567", "feature/from-git"), () => FIXED_BUILD_TIME)).toEqual({
      commit: "abcdef1234567",
      branch: "feature/from-git",
      buildTime: FIXED_BUILD_TIME.toISOString(),
    });
  });

  it("preserves an explicit timestamp independently of Git lookup", () => {
    expect(resolvePortalBuildMetadata({
      PORTAL_GIT_INFO_ENABLED: "false",
      BUILD_TIME: "2026-11-03T19:00:00Z",
    }, reader(undefined, undefined), () => FIXED_BUILD_TIME).buildTime)
      .toBe("2026-11-03T19:00:00Z");
  });
});

/** Create a spy-backed Git reader for precedence and no-call assertions. */
function reader(
  commit: string | undefined,
  branch: string | undefined,
): PortalGitMetadataReader {
  return {
    readCommit: vi.fn(() => commit),
    readBranch: vi.fn(() => branch),
  };
}
