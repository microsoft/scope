// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const { parse }: { parse: (source: string) => unknown } =
  createRequire(resolve("packages/shared/package.json"))("yaml");

describe("Worker Version Upgrade activation", () => {
  it("filters issue labels without failing pre-activation and preserves dispatch and membership checks", () => {
    const source = readFileSync(".github/workflows/worker-version-upgrade.md", "utf8");
    const frontmatter = parse(source.split("---")[1]) as {
      on: { issues: { types: string[]; names: string[] }; workflow_dispatch: null; steps?: unknown };
      if: string;
    };
    const lock = parse(readFileSync(".github/workflows/worker-version-upgrade.lock.yml", "utf8")) as {
      on: { issues: { types: string[] }; workflow_dispatch: unknown };
      jobs: Record<string, {
        if?: string;
        needs?: string | string[];
        outputs?: Record<string, string>;
        steps?: { id?: string; env?: Record<string, string> }[];
      }>;
    };
    const condition = "github.event_name == 'workflow_dispatch' || contains(github.event.issue.labels.*.name, format('type:{0}worker-update', ' '))";

    // Array membership requires the complete label, whether alone or among other labels.
    expect(frontmatter.on.issues).toEqual({ types: ["opened", "edited"], names: ["type: worker-update"] });
    expect(frontmatter.on.workflow_dispatch).toBeNull();
    expect(frontmatter.on.steps).toBeUndefined();
    expect(frontmatter.if).toBe(condition);
    expect(lock.on.issues.types).toEqual(["opened", "edited"]);
    expect(lock.on.workflow_dispatch).toBeDefined();
    expect(lock.jobs.pre_activation.if?.trim()).toBe(condition);
    expect(lock.jobs.pre_activation.steps?.some((step) => step.id === "label_check")).toBe(false);

    // Dispatch bypasses the label filter, but both paths still require membership.
    expect(lock.jobs.pre_activation.outputs?.activated).toBe("${{ steps.check_membership.outputs.is_team_member == 'true' }}");
    expect(lock.jobs.pre_activation.steps?.find((step) => step.id === "check_membership")?.env?.GH_AW_REQUIRED_ROLES)
      .toBe("admin,maintainer,write");
    expect(lock.jobs.activation.needs).toBe("pre_activation");
    expect(lock.jobs.activation.if?.trim()).toBe(`needs.pre_activation.outputs.activated == 'true' && (${condition})`);
    expect(lock.jobs.agent.needs).toBe("activation");
  });
});
