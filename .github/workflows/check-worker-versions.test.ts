// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Reuse shared's existing YAML dependency, as the worker Dockerfiles do.
const { parse }: { parse: (source: string) => unknown } =
  createRequire(resolve("packages/shared/package.json"))("yaml");

interface Step {
  id?: string;
  name?: string;
  run?: string;
  env?: Record<string, string>;
}

interface WorkerVersionWorkflow {
  permissions: Record<string, string>;
  jobs: Record<string, { steps: Step[] }>;
}

const workflow = parse(readFileSync(".github/workflows/check-worker-versions.yml", "utf8")) as WorkerVersionWorkflow;
const setupStep = workflow.jobs["setup-matrix"].steps.find((candidate) => candidate.id === "set")!;
const createIssueStep = workflow.jobs["check-versions"].steps.find((candidate) => candidate.id === "create_issue")!;
const dispatchUpgradeStep = workflow.jobs["check-versions"].steps.find(
  (candidate) => candidate.name === "Dispatch worker version upgrade",
)!;
const expectedWorkers = [
  { worker: "coder-acp-copilot", checker: "version-checker-acp-copilot" },
  { worker: "coder-acp-claude-code", checker: "version-checker-claude-code" },
];
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// Execute the same setup script GitHub Actions uses and parse its matrix output.
function selectedWorkers(input: string): typeof expectedWorkers {
  const directory = mkdtempSync(join(tmpdir(), "scope-worker-matrix-"));
  directories.push(directory);
  const output = join(directory, "github-output");
  const script = setupStep.run!.replace("${{ github.event.inputs.worker }}", input);
  const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      ALL: setupStep.env!.ALL,
      GITHUB_OUTPUT: output,
    },
  });

  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);

  const matrixOutput = readFileSync(output, "utf8").trim().replace(/^matrix=/, "");
  return JSON.parse(matrixOutput).include;
}

describe("Check Worker Versions workflow", () => {
  it("defines every supported worker and version checker", () => {
    expect(JSON.parse(setupStep.env!.ALL)).toEqual(expectedWorkers);
  });

  it("selects all workers when the dispatch input is blank", () => {
    expect(selectedWorkers("")).toEqual(expectedWorkers);
  });

  it.each(expectedWorkers)("selects only $worker when requested", ({ worker, checker }) => {
    expect(selectedWorkers(worker)).toEqual([{ worker, checker }]);
  });

  it("dispatches the upgrade workflow explicitly after creating an issue", () => {
    expect(workflow.permissions.actions).toBe("write");
    expect(createIssueStep.env?.GH_TOKEN).toBe("${{ secrets.GITHUB_TOKEN }}");
    expect(createIssueStep.run).toContain('echo "issue_number=$ISSUE_NUMBER" >> $GITHUB_OUTPUT');
    expect(dispatchUpgradeStep.env?.GH_TOKEN).toBe("${{ secrets.GITHUB_TOKEN }}");
    expect(dispatchUpgradeStep.run).toContain("gh workflow run worker-version-upgrade.lock.yml");
    expect(dispatchUpgradeStep.run).toContain('-f issue_number="${{ steps.create_issue.outputs.issue_number }}"');
    expect(dispatchUpgradeStep.run).toContain('--arg actor "${{ github.actor }}"');
    expect(dispatchUpgradeStep.run).toContain('--arg command_name "worker-version-upgrade"');
  });
});
