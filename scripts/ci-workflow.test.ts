// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
  shell?: string;
}

interface Job {
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  "runs-on"?: string;
  steps: Step[];
  strategy?: { matrix: { worker: { name: string; dockerfile: string; versions_env: string; test_pattern: string; images: string }[] } };
}

const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
};
const jobs = workflow.jobs;
const directories: string[] = [];
const trusted = "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository";

function step(job: string, name: string): Step {
  const result = jobs[job].steps.find((candidate) => candidate.name === name);
  if (!result) throw new Error(`Missing step ${job}: ${name}`);
  return result;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("CI execution prerequisites", () => {
  it("selects integration checks for workflow changes through a dedicated filter", () => {
    const filtersStep = jobs["detect-changes"].steps.find((candidate) => candidate.uses?.startsWith("dorny/paths-filter@"));
    const filters = parse(filtersStep!.with!.filters) as Record<string, string[]>;
    expect(filters.ci).toContain(".github/workflows/ci.yml");
    expect(filters.ci).toContain("scripts/ci-workflow.test.ts");
    expect(filters.typescript).toContain("scripts/ci-workflow.test.ts");
    expect(filters.shared).not.toContain(".github/workflows/ci.yml");
    expect(jobs["detect-changes"].outputs?.ci).toBe("${{ steps.changes.outputs.ci }}");
    for (const name of ["integration-test", "integration-test-queue"]) {
      expect(jobs[name].if).toContain("needs.detect-changes.outputs.ci == 'true'");
    }
  });

  it("targets each existing ACP worker explicitly instead of a missing root Dockerfile", () => {
    const workers = jobs["integration-test"].strategy!.matrix.worker;
    expect(workers.map((worker) => worker.name)).toEqual(["copilot-acp", "claude-code-acp"]);
    for (const worker of workers) {
      for (const path of [worker.dockerfile, worker.versions_env, worker.test_pattern]) {
        expect(path).toBeTruthy();
        expect(existsSync(path), path).toBe(true);
      }
      expect(worker.images).toContain(`-f ${worker.dockerfile}`);
      expect(worker.images).toContain("--load");
      expect(worker.images).not.toContain("--push");
      expect(spawnSync("bash", ["-n"], { input: worker.images }).status).toBe(0);
      expect(readdirSync(join(worker.test_pattern, "src")).some((file) => file.endsWith(".integration.test.ts"))).toBe(true);
    }
    expect(step("integration-test", "Pre-build Docker test images").run).toContain("${{ matrix.worker.images }}");
  });

  it("parses the remaining inline shell scripts", () => {
    for (const job of Object.values(jobs)) {
      for (const command of job.steps.filter((candidate) => candidate.run && candidate.shell !== "pwsh")) {
        const script = command.run!.replace(/\$\{\{.*?\}\}/g, "placeholder");
        const result = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
        expect(result.stderr, command.name).toBe("");
        expect(result.status, command.name).toBe(0);
      }
    }
  });

  for (const recordings of [false, true]) {
    it(`collects videos successfully ${recordings ? "with nested recordings and spaces in paths" : "without any test-output directories"}`, () => {
      const directory = mkdtempSync(join(tmpdir(), "scope-ci-video-"));
      directories.push(directory);
      mkdirSync(join(directory, "apps/workers"), { recursive: true });
      if (recordings) {
        const output = join(directory, "apps/workers/example/test-output/nested folder");
        mkdirSync(output, { recursive: true });
        writeFileSync(join(output, "first clip.webm"), "first");
        writeFileSync(join(output, "second.webm"), "second");
      }
      const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", step("integration-test", "Collect test videos").run!], {
        cwd: directory, encoding: "utf8",
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const files = readdirSync(join(directory, "test-videos"));
      expect(files).toHaveLength(recordings ? 2 : 0);
      if (recordings) expect(files.map((file) => readFileSync(join(directory, "test-videos", file), "utf8")).sort()).toEqual(["first", "second"]);
      expect(step("integration-test", "Upload test videos").with?.["if-no-files-found"]).toBe("ignore");
    });
  }
});

describe("CI repository and credential boundaries", () => {
  it.each([
    { repository: "microsoft/scope", integration: true },
    { repository: "growth-ecosystems/scope-core", integration: false },
    { repository: "cedricvidal/scope", integration: false },
  ])("selects public integration checks only in their owning repository: $repository", ({ repository, integration }) => {
    for (const name of ["integration-test", "integration-test-queue", "windows-build"]) {
      const gate = jobs[name].if!.match(/github\.repository == '([^']+)' &&/);
      expect(gate, `${name} must retain a mandatory repository gate`).not.toBeNull();
      expect(gate![1] === repository, name).toBe(integration);
    }
  });

  it("does not run fork code through pull_request_target", () => {
    expect(workflow.on).not.toHaveProperty("pull_request_target");
  });

  it("keeps ACP tool checks and queue tests available to upstream fork PRs with read-only tokens", () => {
    for (const name of ["integration-test", "integration-test-queue"]) {
      expect(jobs[name].permissions).toEqual({ contents: "read" });
      expect(jobs[name].if).not.toContain("head.repo");
      expect(jobs[name].env?.DOCKERHUB_LOGIN_ENABLED).toBe("${{ secrets.DOCKERHUB_USERNAME != '' && secrets.DOCKERHUB_TOKEN != '' }}");
      expect(step(name, "Log in to Docker Hub").if).toContain("env.DOCKERHUB_LOGIN_ENABLED == 'true'");
    }
    expect(step("integration-test-queue", "Log in to Docker Hub").if).toContain(trusted);
    expect(jobs["integration-test"].env?.TRUSTED_CODE).toBe(`\${{ ${trusted} }}`);
    expect(step("integration-test", "Log in to Docker Hub").if).toContain("env.TRUSTED_CODE == 'true'");
    for (const value of Object.values(step("integration-test", "Run integration tests").env!)) {
      expect(value).toMatch(/^\$\{\{ env\.TRUSTED_CODE == 'true' && secrets\.\w+ \|\| '' \}\}$/);
    }
  });

  it("has no cloud publishers or OIDC in OSS CI, while preserving reporting and CLI bundles", () => {
    expect(workflow.permissions).not.toHaveProperty("id-token");
    expect(workflow.permissions["pull-requests"]).toBe("write");
    expect(workflow.permissions.issues).toBe("write");
    expect(jobs).not.toHaveProperty("build-images");
    expect(jobs).not.toHaveProperty("build-windows-image");
    expect(workflow.on.workflow_dispatch).toBeNull();
    for (const job of Object.values(jobs)) {
      expect(job.permissions?.["id-token"]).toBeUndefined();
      expect(JSON.stringify(job)).not.toMatch(/azure\/login|az acr|ACR_NAME|scope-core/);
      for (const dependency of typeof job.needs === "string" ? [job.needs] : job.needs ?? []) expect(jobs).toHaveProperty(dependency);
    }
    expect(jobs["llm-evals"].if).toContain(trusted);
    for (const name of ["test", "gateway"]) {
      expect(step(name, "Post test results to Pull Request").run).toContain("github-actions-ctrf pull-request");
    }
    expect(step("cli-bundle-test", "Build CLI bundle").run).toBe("pnpm build:cli");
    expect(step("cli-bundle-test", "Upload CLI bundle").with?.path).toBe("apps/cli/dist/scope.mjs");
  });

  it("removes internal-only automation without removing public Pages or repository maintenance", () => {
    for (const file of ["build-windows-base.yml", "daily-repo-status.md", "daily-repo-status.lock.yml"]) {
      expect(existsSync(join(".github/workflows", file)), file).toBe(false);
    }
    for (const file of ["static.yml", "gitleaks.yml", "check-worker-versions.yml", "daily-test-improver.md", "daily-test-improver.lock.yml", "worker-version-upgrade.md", "worker-version-upgrade.lock.yml"]) {
      expect(existsSync(join(".github/workflows", file)), file).toBe(true);
    }
    for (const file of readdirSync(".github/workflows").filter((file) => /\.ya?ml$/.test(file))) {
      const source = readFileSync(join(".github/workflows", file), "utf8");
      expect(source, file).not.toMatch(/github\.repository == 'growth-ecosystems\/scope-core'|vars\.ACR_NAME/);
    }
  });

  it("validates the full Windows chain on a public hosted runner and gates CI Summary", () => {
    expect(jobs["windows-build"]["runs-on"]).toBe("windows-2022");
    expect(jobs["windows-build"].permissions).toEqual({ contents: "read" });
    expect(jobs["windows-build"].if).not.toContain("head.repo");
    expect(step("windows-build", "Build and smoke-test local Windows images").run).toBe("./scripts/build-windows-worker.ps1");
    expect(jobs["ci-summary"].needs).toContain("windows-build");
    expect(step("ci-summary", "Check overall status").run).toContain('needs.windows-build.result');
    for (const path of ["packages/telemetry/**", "scripts/build-windows-worker.ps1", "pnpm-workspace.yaml", ".dockerignore"]) {
      const filters = jobs["detect-changes"].steps.find((candidate) => candidate.with?.filters)?.with?.filters;
      expect(filters).toContain(path);
    }
  });
});

describe("Public CLI release workflow", () => {
  const release = parse(readFileSync(".github/workflows/publish-cli.yml", "utf8")) as {
    on: Record<string, unknown>;
    concurrency: { group: string; "cancel-in-progress": boolean };
    permissions: Record<string, string>;
    jobs: Record<string, Job>;
  };
  const versionStep = release.jobs.test.steps.find((candidate) => candidate.id === "version");

  it("serializes manual, main-only releases with write permission isolated to publication", () => {
    expect(Object.keys(release.on)).toEqual(["workflow_dispatch"]);
    expect(release.concurrency).toEqual({ group: "publish-cli", "cancel-in-progress": false });
    expect(release.permissions).toEqual({ contents: "read" });
    for (const job of Object.values(release.jobs)) {
      expect(job.if).toBe("github.repository == 'microsoft/scope' && github.ref == 'refs/heads/main'");
    }
    expect(release.jobs.publish.needs).toBe("test");
    expect(release.jobs.publish.permissions).toEqual({ contents: "write" });
    const publish = release.jobs.publish.steps.find((candidate) => candidate.run)!;
    expect(publish.env?.GH_TOKEN).toBe("${{ github.token }}");
    expect(publish.run).toContain('--repo "$GITHUB_REPOSITORY"');
    expect(publish.run).toContain('--target "$COMMIT"');
    expect(publish.env?.COMMIT).toBe("${{ github.sha }}");
    expect(JSON.stringify(release)).not.toMatch(/scope-core|scope-doc|FLUX|id-token|secrets\./);
    expect(release.jobs.test.steps.find((candidate) => candidate.name === "Build CLI bundle")?.run).toBe("pnpm build:cli");
    expect(release.jobs.test.steps.find((candidate) => candidate.name === "Test release bundle")?.run).toContain("apps/cli/src/bundle.integration.test.ts");
    const upload = release.jobs.test.steps.find((candidate) => candidate.uses?.startsWith("actions/upload-artifact@"));
    const download = release.jobs.publish.steps.find((candidate) => candidate.uses?.startsWith("actions/download-artifact@"));
    expect(upload?.with?.path).toBe("apps/cli/dist/scope.mjs");
    expect(download?.with?.name).toBe(upload?.with?.name);
    for (const job of Object.values(release.jobs)) {
      for (const command of job.steps.filter((candidate) => candidate.run)) {
        expect(spawnSync("bash", ["-n"], { input: command.run }).status, command.name).toBe(0);
      }
    }
  });

  it.each([
    { tags: "cli/v1.9.0\ncli/v1.10.0", bump: "patch", expected: "1.10.1" },
    { tags: "", bump: "minor", expected: "0.1.0", packageVersion: "0.0.0-dev" },
    { tags: "", bump: "minor", expected: "3.5.0", packageVersion: "3.4.5" },
    { tags: "", bump: "minor", expected: undefined, packageVersion: "invalid" },
    { tags: "cli/vbad", bump: "patch", expected: undefined },
    { tags: "cli/v1.0.0", bump: "invalid", expected: undefined },
    { tags: "", bump: "patch", expected: undefined, gitError: "1" },
  ])("resolves release versions without hiding invalid tags or git failures: $tags / $bump", ({ tags, bump, expected, gitError, packageVersion }) => {
    const directory = mkdtempSync(join(tmpdir(), "scope-cli-release-"));
    directories.push(directory);
    writeFileSync(join(directory, "git"), '#!/bin/sh\nif [ "$TEST_GIT_ERROR" = "1" ]; then echo "git read failed" >&2; exit 1; fi\nprintf "%s" "$TEST_TAGS"\n', { mode: 0o755 });
    writeFileSync(join(directory, "package.json"), JSON.stringify({ version: packageVersion ?? "0.0.0-dev" }));
    symlinkSync(resolve("apps/cli/node_modules"), join(directory, "node_modules"), "dir");
    const output = join(directory, "output");
    const versionScript = versionStep!.run!.match(/^node --input-type=module <<'NODE'\n([\s\S]+)\nNODE\n$/)![1];
    const result = spawnSync(process.execPath, ["--input-type=module"], {
      input: versionScript,
      cwd: directory,
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, TEST_TAGS: tags, TEST_GIT_ERROR: gitError ?? "", BUMP: bump, GITHUB_OUTPUT: output },
      encoding: "utf8",
      timeout: 10000,
    });
    if (expected) {
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(output, "utf8")).toBe(`version=${expected}\n`);
      if (!tags) expect(result.stdout).toContain(`bootstrapping from package version ${packageVersion}`);
    } else {
      expect(result.status).not.toBe(0);
      expect(existsSync(output)).toBe(false);
    }
  });
});
