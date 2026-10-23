// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  flattenDiagnosticMessageText,
  ModuleKind,
  ScriptTarget,
  transpileModule,
} from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const example = fileURLToPath(
  new URL("../../../examples/taxonome-custom-handler/", import.meta.url),
);
const ANSI_PATTERN = /\u001b\[[0-9;]*m/;
let pluginOutputDirectory: string | undefined;
let pluginSpecifier: string;

/** Returns a child environment with every supported credential removed. */
function childEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    COPILOT_GITHUB_TOKEN: "",
    GH_TOKEN: "",
    GITHUB_TOKEN: "",
    ...overrides,
  };
}

/** Runs the source CLI as if it were globally installed while preserving cwd. */
function runCli(
  args: string[],
  cwd = root,
  environment = childEnvironment(),
) {
  return exec(
    process.execPath,
    [
      "--conditions=source",
      "--import",
      "tsx",
      fileURLToPath(new URL("./index.ts", import.meta.url)),
      ...args,
    ],
    { cwd, env: environment },
  );
}

describe("YAML/archive/plugin CLI process contract", () => {
  beforeAll(async () => {
    // Emit trusted fixture JavaScript without depending on ignored package
    // declarations. Normal package builds separately type-check the example.
    pluginOutputDirectory = await mkdtemp(join(
      example,
      ".taxonome-test-plugin-",
    ));
    pluginSpecifier = `./${basename(pluginOutputDirectory)}/handlers/index.js`;
    const source = await readFile(
      join(example, "src/handlers/index.ts"),
      "utf8",
    );
    const compiled = transpileModule(source, {
      fileName: "index.ts",
      reportDiagnostics: true,
      compilerOptions: {
        module: ModuleKind.ESNext,
        target: ScriptTarget.ES2022,
      },
    });
    if (compiled.diagnostics?.length) {
      throw new Error(compiled.diagnostics
        .map(diagnostic =>
          flattenDiagnosticMessageText(diagnostic.messageText, "\n")
        )
        .join("; "));
    }
    const handlerDirectory = join(pluginOutputDirectory, "handlers");
    await mkdir(handlerDirectory);
    await writeFile(join(handlerDirectory, "index.js"), compiled.outputText);
  });

  afterAll(async () => {
    if (pluginOutputDirectory) {
      await rm(pluginOutputDirectory, { recursive: true, force: true });
    }
  });

  it("requires --taxonomy and emits no success-shaped stdout on configuration errors", async () => {
    const commands = [
      [
        "run",
        "packages/ax-taxonomy/fixtures/timeout.atif.json",
      ],
      ["eval", "--cases", "cases.jsonl", "--gold", "gold.json"],
      [
        "optimize",
        "--cases",
        "cases.jsonl",
        "--gold",
        "gold.json",
        "--element",
        "beh-skipped-invocation",
        "--output",
        "artifact.json",
      ],
    ];

    for (const args of commands) {
      await expect(runCli(args)).rejects.toMatchObject({
        code: 1,
        stdout: "",
        stderr: expect.stringContaining("required option '--taxonomy"),
      });
    }
  });

  it("runs a built-in deterministic YAML element without credentials or SDK calls", async () => {
    const { stdout, stderr } = await runCli([
      "run",
      "packages/ax-taxonomy/fixtures/timeout.atif.json",
      "--taxonomy",
      "packages/ax-taxonomy/taxonomy/taxonomy.yaml",
      "--elements",
      "beh-timeout",
    ]);

    expect(JSON.parse(stdout)).toMatchObject({
      results: [{
        taxonomy: {
          id: "agent-behavior",
          version: "2.0.0",
        },
        element: { id: "beh-timeout" },
        implementation: {
          type: "deterministic",
          handler: "scope/timeout-v1",
        },
        result: { state: "completed", observed: true },
      }],
      metadata: { strategy: "deterministic" },
    });
    expect(stderr).toBe("");
  });

  it("fails concisely without a custom plugin and succeeds with an explicit project-relative plugin", async () => {
    const missing = runCli([
      "run",
      "inputs/run.atif.json",
      "--taxonomy",
      "taxonomy.yaml",
      "--elements",
      "acme-retry-loop",
    ], example);
    await expect(missing).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.stringContaining(
        "Unknown deterministic handler 'acme/retry-loop-v1'",
      ),
    });

    const { stdout } = await runCli([
      "run",
      "inputs/run.atif.json",
      "--taxonomy",
      "taxonomy.yaml",
      "--plugin",
      pluginSpecifier,
      "--elements",
      "acme-retry-loop",
    ], example);
    expect(JSON.parse(stdout)).toMatchObject({
      results: [{
        implementation: {
          handler: "acme/retry-loop-v1",
          provider: {
            name: "taxonome-custom-handler-example",
            origin: "local",
            entry: pluginSpecifier,
            integrity: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        },
        result: {
          state: "completed",
          observed: true,
          occurrences: [{
            tool_call_id: "retry-1",
            attempts: 3,
          }],
        },
      }],
    });
  });

  it("runs the same custom taxonomy/handler against an existing Scope archive", async () => {
    const { stdout } = await runCli([
      "run",
      "inputs/run.tar.gz",
      "--taxonomy",
      "taxonomy.yaml",
      "--plugin",
      pluginSpecifier,
      "--elements",
      "acme-retry-loop",
    ], example);
    expect(JSON.parse(stdout)).toMatchObject({
      run: {
        id: "acme-run-archive",
        scenario: { id: "retry" },
      },
      results: [{
        result: {
          observed: true,
          occurrences: [{
            related_turns: [2],
            tool_call_id: "retry-1",
            origin: {
              iteration: 1,
              step_id: 2,
              tool_call_id: "retry-1",
            },
          }],
        },
      }],
    });
  });

  it("builds readout JSON/Markdown and verifies the loaded taxonomy digest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taxonome-readout-"));
    try {
      const run = await runCli([
        "run",
        "inputs/run.atif.json",
        "--taxonomy",
        "taxonomy.yaml",
        "--plugin",
        pluginSpecifier,
        "--elements",
        "acme-retry-loop",
      ], example);
      const evaluated = JSON.parse(run.stdout) as {
        run: unknown;
        results: unknown[];
      };
      const resultsPath = join(directory, "results.json");
      const markdownPath = join(directory, "preview.md");
      await writeFile(resultsPath, JSON.stringify([{
        run: evaluated.run,
        results: evaluated.results,
      }]));

      const { stdout } = await runCli([
        "readout",
        resultsPath,
        "--taxonomy",
        "taxonomy.yaml",
        "--plugin",
        pluginSpecifier,
        "--markdown",
        markdownPath,
      ], example);
      const report = JSON.parse(stdout);
      expect(report).toMatchObject({
        schema_version: "scope/taxonomy-readout/v1",
        groups: [{
          behaviors: [{
            element_id: "acme-retry-loop",
            distinct_runs: 1,
            occurrences: 1,
          }],
        }],
      });
      expect(await readFile(markdownPath, "utf8")).toContain(
        "Recovered Retry Loop",
      );

      evaluated.results[0] = {
        ...(evaluated.results[0] as Record<string, unknown>),
        taxonomy: { id: "tampered", version: "1.0.0", digest: "tampered" },
      };
      await writeFile(resultsPath, JSON.stringify([{
        run: evaluated.run,
        results: evaluated.results,
      }]));
      await expect(runCli([
        "readout",
        resultsPath,
        "--taxonomy",
        "taxonomy.yaml",
        "--plugin",
        pluginSpecifier,
      ], example)).rejects.toMatchObject({
        code: 1,
        stdout: "",
        stderr: expect.stringContaining("does not match"),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps pnpm machine stdout valid JSON and free of ANSI", async () => {
    const { stdout, stderr } = await exec("pnpm", [
      "--silent",
      "taxonome",
      "run",
      "packages/ax-taxonomy/fixtures/timeout.atif.json",
      "--taxonomy",
      "packages/ax-taxonomy/taxonomy/taxonomy.yaml",
      "--elements",
      "beh-timeout",
    ], {
      cwd: root,
      env: childEnvironment({ FORCE_COLOR: "1" }),
    });

    expect(stdout).not.toMatch(ANSI_PATTERN);
    expect(() => JSON.parse(stdout) as unknown).not.toThrow();
    expect(stderr).toBe("");
  });

  it("keeps redirected help/errors plain and accessible", async () => {
    const help = await runCli(["run", "--help"]);
    expect(help.stdout).toBe("");
    expect(help.stderr).toContain("Usage:");
    expect(help.stderr).toContain("--taxonomy");
    expect(help.stderr).not.toContain("--context");
    expect(help.stderr).not.toMatch(ANSI_PATTERN);

    const error = runCli(
      ["run", "missing.json", "--taxonomy", "missing.yaml"],
      root,
      childEnvironment({ NO_COLOR: "1", FORCE_COLOR: "1" }),
    );
    await expect(error).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.stringContaining("taxonome:"),
    });
    await expect(error).rejects.toMatchObject({
      stderr: expect.not.stringMatching(ANSI_PATTERN),
    });
  });
});
