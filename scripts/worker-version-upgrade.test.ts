// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const { parse }: { parse: (source: string) => unknown } =
  createRequire(resolve("packages/shared/package.json"))("yaml");

/** A synthetic GitHub event and its expected label-gate outcome. */
interface EventFixture {
  /** Case name shown by Vitest. */
  name: string;
  /** Event passed to act independently of the payload. */
  eventName: "issues" | "workflow_dispatch";
  /** Contents of the GitHub event file. */
  payload: Record<string, unknown>;
  /** Whether the event should reach the membership check. */
  checksMembership: boolean;
}

const fixtures: EventFixture[] = JSON.parse(readFileSync(
  new URL("./fixtures/worker-version-upgrade-events.json", import.meta.url), "utf8",
));
const lock = parse(readFileSync(resolve(".github/workflows/worker-version-upgrade.lock.yml"), "utf8")) as {
  on: { issues: { types: string[] }; workflow_dispatch: unknown };
  jobs: Record<string, {
    if?: string;
    needs?: string | string[];
    outputs?: Record<string, string>;
    steps?: { id?: string; env?: Record<string, string> }[];
  }>;
};

describe("Worker Version Upgrade activation", () => {
  it("filters issue labels without failing pre-activation and preserves dispatch and membership checks", () => {
    const source = readFileSync(".github/workflows/worker-version-upgrade.md", "utf8");
    const frontmatter = parse(source.split("---")[1]) as {
      on: { issues: { types: string[]; names: string[] }; workflow_dispatch: null; steps?: unknown };
      if: string;
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

  describe.skipIf(process.env.SCOPE_TEST_WORKFLOW_ACT !== "1")("Worker Version Upgrade event fixtures (act)", () => {
    const cases = fixtures.flatMap((fixture) =>
      (fixture.checksMembership ? [true, false] : [true]).map((member) => ({ ...fixture, member })),
    );

    it.each(cases)("$name (membership: $member)", ({ eventName, payload, checksMembership, member }) => {
      const directory = mkdtempSync(join(tmpdir(), "scope-worker-upgrade-act-"));
      try {
        const { pre_activation: preActivation, activation, agent } = lock.jobs;
        // Copy only the wiring under test. Never run production steps or load repository credentials.
        const workflowPath = join(directory, "fixture-workflow.yml");
        writeFileSync(workflowPath, JSON.stringify({
          name: "Worker upgrade gate fixture",
          on: { issues: lock.on.issues, workflow_dispatch: {} },
          jobs: {
            pre_activation: {
              "runs-on": "fixture",
              if: preActivation.if,
              outputs: { activated: preActivation.outputs?.activated },
              steps: [{
                id: "check_membership",
                run: `printf 'is_team_member=%s\\n' '${member}' >> "$GITHUB_OUTPUT"`,
              }],
            },
            activation: {
              "runs-on": "fixture",
              if: activation.if,
              needs: activation.needs,
              steps: [{ run: ":" }],
            },
            agent: { "runs-on": "fixture", if: agent.if, needs: agent.needs, steps: [{ run: ":" }] },
          },
        }));
        const eventPath = join(directory, "event.json");
        writeFileSync(eventPath, JSON.stringify(payload));

        // A disposable home and allowlisted environment keep act config and auth out of the run.
        const result = spawnSync("act", [
          eventName, "--workflows", workflowPath, "--eventpath", eventPath,
          "--platform", "fixture=-self-hosted", "--secret", "GITHUB_TOKEN=",
          "--action-cache-path", join(directory, "cache"), "--no-cache-server",
          "--container-daemon-socket", "-", "--json", "--verbose",
        ], {
          cwd: directory,
          env: { PATH: process.env.PATH, HOME: directory, XDG_CONFIG_HOME: directory },
          encoding: "utf8",
          timeout: 15_000,
        });
        if (result.error) throw new Error("Could not run act; install act and put it on PATH", { cause: result.error });
        const log = result.stdout + result.stderr;
        expect(result.status, log).toBe(0);

        // Check act's terminal status for each job; exit zero alone also permits all jobs to skip.
        const outcomes = Object.fromEntries(log.trim().split("\n").filter(Boolean).flatMap((line) => {
          const entry: { jobID?: string; jobResult?: string } = JSON.parse(line);
          return entry.jobID && entry.jobResult ? [[entry.jobID, entry.jobResult]] : [];
        }));
        expect(outcomes, log).toEqual({
          pre_activation: checksMembership ? "success" : "skipped",
          activation: checksMembership && member ? "success" : "skipped",
          agent: checksMembership && member ? "success" : "skipped",
        });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }, 20_000);
  });
});
