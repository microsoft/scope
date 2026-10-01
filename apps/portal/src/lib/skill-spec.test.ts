// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";

import {
  getRunSkillReferences,
  parseSkillSpec,
  shortCommitHash,
} from "./skill-spec";

describe("skill specs", () => {
  it("parses a revision-qualified skill reference", () => {
    expect(parseSkillSpec("microsoft/example-skills/react-testing@1234567890abcdef")).toEqual({
      slug: "microsoft/example-skills/react-testing",
      commitHash: "1234567890abcdef",
    });
  });

  it("preserves legacy unversioned skill slugs", () => {
    expect(parseSkillSpec("microsoft/example-skills/react-testing")).toEqual({
      slug: "microsoft/example-skills/react-testing",
    });
  });

  it("prefers immutable revision refs and de-duplicates exact entries", () => {
    const revision = "microsoft/example-skills/react-testing@1234567890abcdef";
    expect(getRunSkillReferences({
      skills: ["legacy/skill"],
      skillRevisions: [revision, revision],
    })).toEqual([revision]);
  });

  it("falls back to legacy skill slugs", () => {
    expect(getRunSkillReferences({ skills: ["legacy/skill"] })).toEqual(["legacy/skill"]);
  });

  it("uses the conventional seven-character short commit hash", () => {
    expect(shortCommitHash("1234567890abcdef")).toBe("1234567");
  });
});
