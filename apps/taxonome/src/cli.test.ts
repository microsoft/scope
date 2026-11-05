// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
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
import { extract, pack } from "tar-stream";
import { runBatchFilename } from "./run-batch.js";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const example = fileURLToPath(
  new URL("../../../examples/taxonome-custom-handler/", import.meta.url),
);
const agentBehaviorCatalog = fileURLToPath(
  new URL("../../../packages/ax-taxonomy/", import.meta.url),
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

/** Runs the source CLI with explicit stdin bytes for --files-from -. */
function runCliWithStdin(
  args: string[],
  input: Buffer | string,
  cwd = root,
  environment = childEnvironment(),
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--conditions=source",
        "--import",
        "tsx",
        fileURLToPath(new URL("./index.ts", import.meta.url)),
        ...args,
      ],
      { cwd, env: environment, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", code => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

/** Runs the ax-taxonomy unified eval script with credentials disabled by default. */
function runCatalogEvaluation(
  args: string[],
  environment = childEnvironment(),
) {
  return exec("pnpm", ["eval", "--", ...args], {
    cwd: agentBehaviorCatalog,
    env: environment,
  });
}

/** Repackages the single-root example into two valid roots plus one invalid root. */
async function createMultiRootArchive(
  output: string,
  heavyDiscardedBytes = 0,
): Promise<void> {
  const source = await readFile(join(example, "inputs/run.tar.gz"));
  const unpack = extract();
  const entries: Array<{ name: string; body: Buffer }> = [];
  const completed = new Promise<void>((resolve, reject) => {
    unpack.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", chunk => chunks.push(Buffer.from(chunk)));
      stream.on("end", () => {
        entries.push({ name: header.name, body: Buffer.concat(chunks) });
        next();
      });
      stream.on("error", reject);
      stream.resume();
    });
    unpack.on("finish", resolve);
    unpack.on("error", reject);
  });
  unpack.end(gunzipSync(source));
  await completed;

  const tar = pack();
  const chunks: Buffer[] = [];
  tar.on("data", chunk => chunks.push(Buffer.from(chunk)));
  const finished = new Promise<void>((resolve, reject) => {
    tar.on("end", resolve);
    tar.on("error", reject);
  });
  for (const entry of entries) {
    tar.entry({ name: entry.name, size: entry.body.length }, entry.body);
  }
  for (const entry of entries) {
    const body = entry.name.endsWith("/run.yaml")
      ? Buffer.from(entry.body.toString("utf8")
        .replaceAll("acme-request-1", "acme-request-2")
        .replaceAll("acme-run-archive", "acme-run-second"))
      : entry.body;
    const name = entry.name.replace("acme-request-1/", "acme-request-2/");
    tar.entry({ name, size: body.length }, body);
  }
  const invalidRun = Buffer.from(
    entries.find(entry => entry.name.endsWith("/run.yaml"))!.body.toString("utf8")
      .replaceAll("acme-request-1", "acme-request-3")
      .replaceAll("acme-run-archive", "acme-run-missing"),
  );
  tar.entry({
    name: "acme-request-3/run.yaml",
    size: invalidRun.length,
  }, invalidRun);
  if (heavyDiscardedBytes) {
    const body = randomBytes(heavyDiscardedBytes);
    tar.entry({
      name: "acme-request-3/iteration-1.tar.gz",
      size: body.length,
    }, body);
  }
  tar.finalize();
  await finished;
  await writeFile(output, gzipSync(Buffer.concat(chunks)));
}

/** Repackages the example archive under one explicit root name. */
async function createArchiveWithRoot(
  output: string,
  rootName: string,
): Promise<void> {
  const source = await readFile(join(example, "inputs/run.tar.gz"));
  const unpack = extract();
  const entries: Array<{ name: string; body: Buffer }> = [];
  const completed = new Promise<void>((resolve, reject) => {
    unpack.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", chunk => chunks.push(Buffer.from(chunk)));
      stream.on("end", () => {
        entries.push({ name: header.name, body: Buffer.concat(chunks) });
        next();
      });
      stream.on("error", reject);
      stream.resume();
    });
    unpack.on("finish", resolve);
    unpack.on("error", reject);
  });
  unpack.end(gunzipSync(source));
  await completed;

  const tar = pack();
  const chunks: Buffer[] = [];
  tar.on("data", chunk => chunks.push(Buffer.from(chunk)));
  const finished = new Promise<void>((resolve, reject) => {
    tar.on("end", resolve);
    tar.on("error", reject);
  });
  for (const entry of entries) {
    const name = entry.name.replace(/^[^/]+/, rootName);
    tar.entry({ name, size: entry.body.length }, entry.body);
  }
  tar.finalize();
  await finished;
  await writeFile(output, gzipSync(Buffer.concat(chunks)));
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
      ["eval", "--inputs", "inputs.jsonl", "--ground-truth", "ground-truth.json"],
      [
        "optimize",
        "--inputs",
        "inputs.jsonl",
        "--ground-truth",
        "ground-truth.json",
        "--element",
        "beh-skipped-invocation",
        "--output",
        "artifact.json",
      ],
      ["readout", "results.json"],
    ];

    for (const args of commands) {
      await expect(runCli(args)).rejects.toMatchObject({
        code: 1,
        stdout: "",
        stderr: expect.stringContaining("required option '--taxonomy"),
      });
    }
  });

  it("rejects invalid file-list source combinations before execution", async () => {
        const directory = await mkdtemp(join(tmpdir(), "taxonome-list-options-"));
        try {
          const list = join(directory, "paths.txt");
          await writeFile(
            list,
            "packages/ax-taxonomy/fixtures/timeout.atif.json\n",
          );
          const common = [
            "--taxonomy",
            "packages/ax-taxonomy/taxonomy/taxonomy.yaml",
            "--output-dir",
            join(directory, "out"),
          ];
          for (const [args, expected] of [
            [["run", ...common], "exactly one run input source"],
            [[
              "run",
              "packages/ax-taxonomy/fixtures/timeout.atif.json",
              "--files-from",
              list,
              ...common,
            ], "exactly one run input source"],
            [[
              "run",
              "--files-from",
              list,
              "--files-from",
              list,
              ...common,
            ], "only once"],
            [["run", "--null", ...common], "--null requires"],
          ] as const) {
            await expect(runCli([...args])).rejects.toMatchObject({
              code: 1,
              stdout: "",
              stderr: expect.stringContaining(expected),
            });
          }
          await expect(runCli([
            "run",
            "--files-from",
            list,
            "--taxonomy",
            "packages/ax-taxonomy/taxonomy/taxonomy.yaml",
          ])).rejects.toMatchObject({
            code: 1,
            stdout: "",
            stderr: expect.stringContaining("requires --output-dir"),
          });
          const malformedNul = await runCliWithStdin([
            "run",
            "--files-from",
            "-",
            "--null",
            ...common,
          ], Buffer.from(
            "packages/ax-taxonomy/fixtures/timeout.atif.json\0\0",
          ));
          expect(malformedNul.code).toBe(1);
          expect(malformedNul.stdout).toBe("");
          expect(malformedNul.stderr).toContain(
            "record 2: empty interior path record",
          );
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
  });

  it("rejects list-source/output collisions before execution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taxonome-list-collision-"));
    try {
      const output = join(directory, "results");
      await mkdir(output);
      const selected = await realpath(join(
        root,
        "packages/ax-taxonomy/fixtures/timeout.atif.json",
      ));
      const list = join(output, runBatchFilename({
        root: "input",
        fingerprint: "unused",
        origin: { selected_input: selected },
      }));
      await writeFile(list, `${selected}\n`);

      await expect(runCli([
        "run",
        "--files-from",
        list,
        "--taxonomy",
        "packages/ax-taxonomy/taxonomy/taxonomy.yaml",
        "--elements",
        "beh-timeout",
        "--output-dir",
        output,
        "--json",
      ])).rejects.toMatchObject({
        code: 1,
        stdout: "",
        stderr: expect.stringContaining("would overwrite"),
      });
      expect(await readFile(list, "utf8")).toBe(`${selected}\n`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("runs newline and NUL file lists through one resumable batch", async () => {
        const directory = await mkdtemp(join(tmpdir(), "taxonome-list-batch-"));
        try {
          const list = join(directory, "paths.txt");
          const output = join(directory, "results");
          const firstPath =
            "packages/ax-taxonomy/fixtures/timeout.atif.json";
          const secondPath =
            "packages/ax-taxonomy/fixtures/deterministic-elements.atif.json";
          await writeFile(list, `${firstPath}\n${secondPath}\n`);
          const common = [
            "run",
            "--taxonomy",
            "packages/ax-taxonomy/taxonomy/taxonomy.yaml",
            "--elements",
            "beh-discovered,beh-malformed-invocation,beh-timeout",
            "--output-dir",
            output,
            "--json",
          ];
          const first = await runCli([
            ...common,
            "--files-from",
            list,
          ]);
          expect(JSON.parse(first.stdout)).toEqual({
            evaluated: 2,
            resumed: 0,
            failed: 0,
            cancelled: 0,
            total: 2,
          });
          expect(first.stderr).toContain("BATCH 2 runs :: 3 elements");
          expect(first.stderr).not.toMatch(ANSI_PATTERN);
          const resultFiles = (await (await import("node:fs/promises"))
            .readdir(output)).sort();
          expect(resultFiles).toHaveLength(2);
          const before = await Promise.all(resultFiles.map(async file =>
            (await (await import("node:fs/promises"))
              .stat(join(output, file))).mtimeMs
          ));

          const nul = await runCliWithStdin(
            [
              ...common,
              "--files-from",
              "-",
              "--null",
            ],
            Buffer.from(`${secondPath}\0${firstPath}\0${firstPath}\0`),
          );
          expect(nul.code).toBe(0);
          expect(JSON.parse(nul.stdout)).toEqual({
            evaluated: 0,
            resumed: 2,
            failed: 0,
            cancelled: 0,
            total: 2,
          });
          const after = await Promise.all(resultFiles.map(async file =>
            (await (await import("node:fs/promises"))
              .stat(join(output, file))).mtimeMs
          ));
          expect(after).toEqual(before);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
  });

  it("continues valid listed inputs and persists per-input failures", async () => {
        const directory = await mkdtemp(join(tmpdir(), "taxonome-list-partial-"));
        try {
          const list = join(directory, "paths.txt");
          const output = join(directory, "results");
          await writeFile(
            list,
            [
              "packages/ax-taxonomy/fixtures/timeout.atif.json",
              join(directory, "missing.atif.json"),
            ].join("\n"),
          );
          let failure: {
            code: number;
            stdout: string;
            stderr: string;
          } | undefined;
          try {
            await runCli([
              "run",
              "--files-from",
              list,
              "--taxonomy",
              "packages/ax-taxonomy/taxonomy/taxonomy.yaml",
              "--elements",
              "beh-timeout",
              "--output-dir",
              output,
              "--json",
            ]);
            expect.unreachable();
          } catch (error) {
            failure = error as typeof failure;
          }
          expect(failure).toBeDefined();
          expect(failure!.code).toBe(1);
          expect(JSON.parse(failure!.stdout)).toEqual({
            evaluated: 1,
            resumed: 0,
            failed: 1,
            cancelled: 0,
            total: 2,
          });

          const records = await Promise.all(
            (await (await import("node:fs/promises")).readdir(output))
              .map(async file =>
                JSON.parse(await readFile(join(output, file), "utf8")) as {
                  schema_version?: string;
                  metadata?: {
                    source?: { input_origin?: { selected_input: string } };
                  };
                  input_origin?: { selected_input: string };
                }
              ),
          );
          expect(records).toHaveLength(2);
          expect(records.some(record =>
            record.schema_version === "scope/taxonome-run-error/v1" &&
            record.input_origin?.selected_input.endsWith(
              "missing.atif.json",
            )
          )).toBe(true);
          expect(records.some(record =>
            record.metadata?.source?.input_origin?.selected_input.endsWith(
              "timeout.atif.json",
            )
          )).toBe(true);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
  });

  it("uses one global batch for mixed plain and archive inputs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taxonome-list-mixed-"));
    try {
      const list = join(directory, "paths.txt");
      const output = join(directory, "results");
      await writeFile(
        list,
        "inputs/run.atif.json\ninputs/run.tar.gz\n",
      );
      const result = await runCli([
        "run",
        "--files-from",
        list,
        "--taxonomy",
        "taxonomy.yaml",
        "--plugin",
        pluginSpecifier,
        "--elements",
        "acme-retry-loop",
        "--output-dir",
        output,
        "--concurrency",
        "2",
        "--json",
      ], example);

      expect(JSON.parse(result.stdout)).toEqual({
        evaluated: 2,
        resumed: 0,
        failed: 0,
        cancelled: 0,
        total: 2,
      });
      expect(result.stderr).toContain("BATCH 2 runs :: 1 elements");
      expect(result.stderr).toContain("RUN START");
      expect(result.stderr).toContain('"inputs/run.atif.json"');
      expect(result.stderr).toContain(
        '"inputs/run.tar.gz"#acme-request-1',
      );
      expect((await (await import("node:fs/promises")).readdir(output)))
        .toHaveLength(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves archive identity when the actual archive root is input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taxonome-archive-input-"));
    try {
      const archive = join(directory, "archive-root-input.json");
      const plain = join(example, "inputs/run.atif.json");
      const list = join(directory, "paths.txt");
      const output = join(directory, "results");
      await createArchiveWithRoot(archive, "input");
      await writeFile(list, `${plain}\n${archive}\n`);
      const common = [
        "run",
        "--files-from",
        list,
        "--taxonomy",
        "taxonomy.yaml",
        "--plugin",
        pluginSpecifier,
        "--elements",
        "acme-retry-loop",
        "--output-dir",
        output,
        "--json",
      ];

      const first = await runCli(common, example);
      expect(JSON.parse(first.stdout)).toEqual({
        evaluated: 2,
        resumed: 0,
        failed: 0,
        cancelled: 0,
        total: 2,
      });
      const records = await Promise.all(
        (await (await import("node:fs/promises")).readdir(output))
          .map(async file =>
            JSON.parse(await readFile(join(output, file), "utf8")) as {
              results: Array<{ input: { archive_root?: string } }>;
              metadata: {
                source: {
                  archive_root?: string;
                  input_origin: {
                    selected_input: string;
                    archive_root?: string;
                  };
                };
              };
            }
          ),
      );
      const archiveRecord = records.find(record =>
        record.metadata.source.input_origin.archive_root === "input"
      );
      const plainRecord = records.find(record =>
        record.metadata.source.input_origin.archive_root === undefined
      );
      expect(archiveRecord).toBeDefined();
      expect(archiveRecord!.metadata.source).toMatchObject({
        archive_root: "input",
        input_origin: {
          selected_input: await realpath(archive),
          archive_root: "input",
        },
      });
      expect(archiveRecord!.results[0].input.archive_root).toBe("input");
      expect(plainRecord).toBeDefined();
      expect(plainRecord!.metadata.source.archive_root).toBeUndefined();
      expect(plainRecord!.metadata.source.input_origin).toEqual({
        selected_input: await realpath(plain),
      });
      expect(plainRecord!.results[0].input.archive_root).toBeUndefined();

      const resumed = await runCli(common, example);
      expect(JSON.parse(resumed.stdout)).toEqual({
        evaluated: 0,
        resumed: 2,
        failed: 0,
        cancelled: 0,
        total: 2,
      });

      const readout = await runCli([
        "readout",
        output,
        "--taxonomy",
        "taxonomy.yaml",
        "--inputs",
        plain,
        "--inputs",
        archive,
        "--plugin",
        pluginSpecifier,
      ], example);
      expect(JSON.parse(readout.stdout)).toMatchObject({
        failed_runs: [],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("runs a built-in deterministic YAML element without credentials or SDK calls", async () => {
    const human = await runCli([
      "run",
      "packages/ax-taxonomy/fixtures/timeout.atif.json",
      "--taxonomy",
      "packages/ax-taxonomy/taxonomy/taxonomy.yaml",
      "--elements",
      "beh-timeout",
    ]);
    expect(human.stdout).toContain("Taxonomy: agent-behavior v3.0.0");
    expect(human.stdout).toContain(
      "Timeout (beh-timeout): deterministic (scope/timeout-v1)",
    );
    expect(human.stdout).toContain("Observed: yes");
    expect(human.stdout.trimStart()).not.toMatch(/^[{\[]/);
    expect(human.stderr).toContain(
      "BATCH 1 runs :: 1 elements :: concurrency=1",
    );
    expect(human.stderr).toContain(
      "ELEMENT START input :: Code/Deterministic Timeout",
    );
    expect(human.stderr).toContain("RUN COMPLETED input");
    expect(human.stderr).not.toMatch(ANSI_PATTERN);

    const { stdout, stderr } = await runCli([
      "run",
      "packages/ax-taxonomy/fixtures/timeout.atif.json",
      "--taxonomy",
      "packages/ax-taxonomy/taxonomy/taxonomy.yaml",
      "--elements",
      "beh-timeout",
      "--json",
    ]);
    expect(JSON.parse(stdout)).toMatchObject({
      results: [{
        taxonomy: {
          id: "agent-behavior",
          version: "3.0.0",
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
    expect(stderr).toContain(
      "BATCH 1 runs :: 1 elements :: concurrency=1",
    );
    expect(stderr).toContain("RUN COMPLETED input");
    expect(stderr).not.toMatch(ANSI_PATTERN);
  });

  it("renders both new deterministic catalog elements without credentials", async () => {
    const { stdout, stderr } = await runCli([
      "run",
      "packages/ax-taxonomy/fixtures/deterministic-elements.atif.json",
      "--taxonomy",
      "packages/ax-taxonomy/taxonomy/taxonomy.yaml",
      "--elements",
      "beh-discovered,beh-malformed-invocation",
    ]);

    expect(stdout).toContain("Discovered (beh-discovered): deterministic");
    expect(stdout).toContain(
      "discovery=$.steps[1].extra.scope.discoveries[0]",
    );
    expect(stdout).toContain(
      "Malformed Invocation (beh-malformed-invocation): deterministic",
    );
    expect(stdout).toContain("call=$.steps[1].tool_calls[0]");
    expect(stdout).toContain(
      "issue=$.steps[1].tool_calls[0].extra.scope.input_validation.issues[0]",
    );
    expect(stderr).toContain(
      "BATCH 1 runs :: 2 elements :: concurrency=1",
    );
    expect(stderr).toContain(
      "ELEMENT START input :: Code/Deterministic Discovered",
    );
    expect(stderr).toContain(
      "ELEMENT DONE input :: Code/Deterministic Malformed Invocation",
    );
    expect(stderr).toContain("RUN COMPLETED input");
    expect(stderr).not.toMatch(ANSI_PATTERN);
  });

  it("evaluates deterministic inputs without credentials or SDK", async () => {
    const { stdout, stderr } = await runCli([
      "eval",
      "--taxonomy",
      "packages/ax-taxonomy/taxonomy/taxonomy.yaml",
      "--inputs",
      "packages/ax-taxonomy/fixtures/discovered-inputs.jsonl",
      "--inputs",
      "packages/ax-taxonomy/fixtures/malformed-invocation-inputs.jsonl",
      "--inputs",
      "packages/ax-taxonomy/fixtures/timeout-inputs.jsonl",
      "--ground-truth",
      "packages/ax-taxonomy/fixtures/discovered-ground-truth.json",
      "--ground-truth",
      "packages/ax-taxonomy/fixtures/malformed-invocation-ground-truth.json",
      "--ground-truth",
      "packages/ax-taxonomy/fixtures/timeout-ground-truth.json",
      "--split",
      "test",
      "--json",
    ]);
    const output = JSON.parse(stdout);

    expect(output).toMatchObject({
      passed: 3,
      total: 3,
      metadata: {
        concurrency: 4,
        workers: [
          { worker_id: 0, initialized: false },
          { worker_id: 1, initialized: false },
          { worker_id: 2, initialized: false },
        ],
      },
    });
    expect(output.rows.map((row: { input_id: string }) => row.input_id))
      .toEqual([
        "det-input-discovered",
        "det-input-malformed",
        "det-input-timeout",
      ]);
    expect(output.rows.flatMap((row: {
      results: Array<{ element: { id: string } }>;
    }) => row.results.map(result => result.element.id))).toEqual([
      "beh-discovered",
      "beh-malformed-invocation",
      "beh-timeout",
    ]);
    expect(stderr).not.toContain("authenticated");
    expect(stderr).toContain(
      "START Code/Deterministic Discovered (beh-discovered); no model calls",
    );
  });

  it("preflights the available-only prompt input without credentials or SDK initialization", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taxonome-preflight-"));
    try {
      const fixtureDirectory = join(root, "packages/ax-taxonomy/fixtures");
      const line = (await readFile(
        join(fixtureDirectory, "skipped-invocation-test-inputs.jsonl"),
        "utf8",
      )).trim().split("\n").find(candidate =>
        candidate.includes("\"id\":\"final-available-only\"")
      );
      if (!line) throw new Error("Missing final-available-only fixture");
      const fullGold = JSON.parse(await readFile(
        join(
          fixtureDirectory,
          "skipped-invocation-test-ground-truth.json",
        ),
        "utf8",
      )) as Record<string, unknown>;
      const inputsPath = join(directory, "inputs.jsonl");
      const groundTruthPath = join(directory, "ground-truth.json");
      await writeFile(inputsPath, `${line}\n`);
      await writeFile(groundTruthPath, JSON.stringify({
        "final-available-only": fullGold["final-available-only"],
      }));
      const args = [
        "eval",
        "--taxonomy",
        join(root, "packages/ax-taxonomy/taxonomy/taxonomy.yaml"),
        "--inputs",
        inputsPath,
        "--ground-truth",
        groundTruthPath,
        "--split",
        "test",
        "--element",
        "beh-skipped-invocation",
      ];

      const human = await runCli(args);
      expect(human.stdout).toContain("Result: 1 passed; 0 failed");
      expect(human.stdout).toContain("PASS final-available-only");
      expect(human.stderr).toContain(
        "START Prompt Skipped Invocation (beh-skipped-invocation); model calls possible",
      );

      const machine = await runCli([...args, "--json"]);
      expect(JSON.parse(machine.stdout)).toMatchObject({
        passed: 1,
        total: 1,
        metadata: {
          workers: [{ worker_id: 0, initialized: false }],
        },
        rows: [{
          input_id: "final-available-only",
          results: [{
            result: { state: "completed", observed: false },
          }],
          errors: [],
        }],
      });
      expect(machine.stderr).not.toMatch(ANSI_PATTERN);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects invalid element selectors and splits before resolving inputs", async () => {
    const base = [
      "eval",
      "--taxonomy",
      "packages/ax-taxonomy/taxonomy/taxonomy.yaml",
      "--inputs",
      "missing-inputs.jsonl",
      "--ground-truth",
      "missing-ground-truth.json",
    ];
    await expect(runCli([
      ...base,
      "--element",
      "beh-unknown",
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("Unknown element 'beh-unknown'"),
    });
    await expect(runCli([
      ...base,
      "--element",
      "beh-timeout",
      "--element",
      "beh-discovered",
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("--element may be supplied only once"),
    });
    await expect(runCli([
      ...base,
      "--split",
      "unit",
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("Invalid split"),
    });
    await expect(runCli([
      ...base,
      "--concurrency",
      "17",
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("--concurrency must be 1..16"),
    });
  });

  it("rejects artifacts for deterministic or unselected elements before SDK use", async () => {
    const deterministic = runCli([
      "eval",
      "--taxonomy",
      "packages/ax-taxonomy/taxonomy/taxonomy.yaml",
      "--inputs",
      "packages/ax-taxonomy/fixtures/timeout-inputs.jsonl",
      "--ground-truth",
      "packages/ax-taxonomy/fixtures/timeout-ground-truth.json",
      "--element",
      "beh-timeout",
      "--artifact",
      "missing.ax.json",
    ]);
    await expect(deterministic).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "--artifact requires at least one prompt element",
      ),
    });

    const directory = await mkdtemp(join(tmpdir(), "taxonome-artifact-"));
    try {
      const artifactPath = join(directory, "wrong-element.ax.json");
      await writeFile(artifactPath, JSON.stringify({
        element_id: "beh-timeout",
      }));
      await expect(runCli([
        "eval",
        "--taxonomy",
        "packages/ax-taxonomy/taxonomy/taxonomy.yaml",
        "--inputs",
        "packages/ax-taxonomy/fixtures/skipped-invocation-test-inputs.jsonl",
        "--ground-truth",
        "packages/ax-taxonomy/fixtures/skipped-invocation-test-ground-truth.json",
        "--element",
        "beh-skipped-invocation",
        "--artifact",
        artifactPath,
      ])).rejects.toMatchObject({
        stderr: expect.stringContaining(
          "targets unselected or non-prompt element 'beh-timeout'",
        ),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("continues after reviewed failures and keeps JSON progress ANSI-free", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taxonome-failures-"));
    try {
      const inputsPath = join(directory, "failure-inputs.jsonl");
      const groundTruthPath = join(directory, "failure-ground-truth.json");
      const makeInput = (id: string, callId: string) => ({
        id,
        family: `family-${id}`,
        originating_run: `run-${id}`,
        split: "test",
        provenance: "failure continuation fixture",
        elements: ["beh-timeout"],
        atif: {
          schema_version: "ATIF-v1.7",
          session_id: `session-${id}`,
          agent: { name: "fixture", version: "1.0.0" },
          steps: [{
            step_id: 1,
            source: "agent",
            message: "Timed out.",
            tool_calls: [{
              tool_call_id: callId,
              function_name: "query",
              arguments: {},
              extra: { scope: { outcome: "timeout" } },
            }],
          }],
        },
      });
      await writeFile(inputsPath, [
        makeInput("input-fail", "call-fail"),
        makeInput("input-pass", "call-pass"),
      ].map(value => JSON.stringify(value)).join("\n"));
      await writeFile(groundTruthPath, JSON.stringify({
        "input-fail": {
          "beh-timeout": { state: "completed", observed: false },
        },
        "input-pass": {
          "beh-timeout": {
            state: "completed",
            observed: true,
            occurrences: [{
              evidence: [{
                role: "call",
                path: "$.steps[0].tool_calls[0]",
              }],
            }],
          },
        },
      }));

      let failure: {
        code: number;
        stdout: string;
        stderr: string;
      } | undefined;
      try {
        await runCli([
          "eval",
          "--taxonomy",
          "packages/ax-taxonomy/taxonomy/taxonomy.yaml",
          "--inputs",
          inputsPath,
          "--ground-truth",
          groundTruthPath,
          "--split",
          "test",
          "--json",
        ], root, childEnvironment({ FORCE_COLOR: "1" }));
        expect.unreachable();
      } catch (error) {
        failure = error as typeof failure;
      }
      expect(failure).toBeDefined();
      const observedFailure = failure!;
      expect(observedFailure.code).toBe(1);
      expect(JSON.parse(observedFailure.stdout)).toMatchObject({
        passed: 1,
        total: 2,
        rows: [
          { input_id: "input-fail", errors: expect.arrayContaining([
            expect.stringContaining("observed expected false"),
          ]) },
          { input_id: "input-pass", errors: [] },
        ],
      });
      expect(observedFailure.stderr.indexOf("input-fail"))
        .toBeLessThan(observedFailure.stderr.lastIndexOf("input-pass"));
      expect(observedFailure.stderr).toContain("Failure details:");
      expect(observedFailure.stderr).toContain("Timeout (beh-timeout):");
      expect(observedFailure.stderr.indexOf("FAIL Code/Deterministic"))
        .toBeLessThan(observedFailure.stderr.indexOf("Failure details:"));
      expect(observedFailure.stderr).not.toMatch(ANSI_PATTERN);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("renders the new prompt elements from authoritative preflights", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taxonome-prompt-preflight-"));
    try {
      const fixtureDirectory = join(root, "packages/ax-taxonomy/fixtures");
      const selections = [
        {
          inputs: "wrong-discovery-inputs.jsonl",
          inputId: "wd-input-03",
          element: "beh-wrong-discovery",
          expected: [
            "Wrong Discovery (beh-wrong-discovery): prompt; state=completed",
            "Observed: no",
          ],
        },
        {
          inputs: "content-misused-inputs.jsonl",
          inputId: "cm-input-06",
          element: "beh-content-misused",
          expected: [
            "Content Misused (beh-content-misused): prompt; state=indeterminate",
            "Reason:",
          ],
        },
      ];

      for (const selection of selections) {
        const row = (await readFile(
          join(fixtureDirectory, selection.inputs),
          "utf8",
        )).trim().split("\n")
          .map(line => JSON.parse(line) as { id: string; atif: unknown })
          .find(candidate => candidate.id === selection.inputId);
        if (!row) throw new Error(`Missing ${selection.inputId} fixture`);
        const inputPath = join(directory, `${selection.inputId}.atif.json`);
        await writeFile(inputPath, JSON.stringify(row.atif));

        const { stdout, stderr } = await runCli([
          "run",
          inputPath,
          "--taxonomy",
          join(root, "packages/ax-taxonomy/taxonomy/taxonomy.yaml"),
          "--elements",
          selection.element,
        ]);
        for (const expected of selection.expected) {
          expect(stdout).toContain(expected);
        }
        expect(stderr).toContain(
          "BATCH 1 runs :: 1 elements :: concurrency=1",
        );
        expect(stderr).toContain("ELEMENT START");
        expect(stderr).toContain(`(${selection.element})`);
        expect(stderr).toContain("RUN COMPLETED");
        expect(stderr).not.toMatch(ANSI_PATTERN);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails concisely without a custom plugin and succeeds with an explicit project-relative plugin", async () => {
    const missing = runCli([
      "run",
      "inputs/run.atif.json",
      "--taxonomy",
      "taxonomy.yaml",
      "--elements",
      "acme-retry-loop",
      "--json",
    ], example);
    await expect(missing).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.stringContaining(
        "Unknown deterministic handler 'acme/retry-loop-v1'",
      ),
    });

    const { stdout, stderr } = await runCli([
      "run",
      "inputs/run.atif.json",
      "--taxonomy",
      "taxonomy.yaml",
      "--plugin",
      pluginSpecifier,
      "--elements",
      "acme-retry-loop",
      "--json",
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
            evidence: [{
              role: "call",
              path: "$.steps[1].tool_calls[0]",
            }],
          }],
        },
      }],
    });
    expect(stderr).toContain(
      "BATCH 1 runs :: 1 elements :: concurrency=1",
    );
    expect(stderr).toContain(
      "ELEMENT START acme-run-1 :: Code/Deterministic",
    );
    expect(stderr).toContain("RUN COMPLETED acme-run-1");
    expect(stderr).not.toMatch(ANSI_PATTERN);
  });

  it("runs the same custom taxonomy/handler against an existing Scope archive", async () => {
    const { stdout, stderr } = await runCli([
      "run",
      "inputs/run.tar.gz",
      "--taxonomy",
      "taxonomy.yaml",
      "--plugin",
      pluginSpecifier,
      "--elements",
      "acme-retry-loop",
      "--json",
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
            evidence: [{
              role: "call",
              path: "$.steps[1].tool_calls[0]",
            }],
          }],
        },
      }],
    });
    expect(stderr).toContain("SCAN START Scope archive");
    expect(stderr).toContain(
      "BATCH 1 runs :: 1 elements :: concurrency=1",
    );
    expect(stderr).toContain(
      "ELEMENT START acme-run-archive :: Code/Deterministic",
    );
    expect(stderr).toContain("RUN COMPLETED acme-run-archive");
    expect(stderr).not.toMatch(ANSI_PATTERN);
  });

  it("requires an output directory for multi-root archives and continues after root failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taxonome-multi-run-"));
    try {
      const archive = join(directory, "runs.tar.gz");
      const output = join(directory, "results");
      await createMultiRootArchive(archive);
      const common = [
        "run",
        archive,
        "--taxonomy",
        "taxonomy.yaml",
        "--plugin",
        pluginSpecifier,
        "--elements",
        "acme-retry-loop",
        "--json",
      ];
      await expect(runCli(common, example)).rejects.toMatchObject({
        code: 1,
        stdout: "",
        stderr: expect.stringContaining("require --output-dir"),
      });

      try {
        await runCli([
          ...common,
          "--output-dir",
          output,
          "--concurrency",
          "2",
        ], example, childEnvironment({ FORCE_COLOR: "1" }));
        throw new Error("Expected the invalid root to fail the batch");
      } catch (error) {
        const failure = error as { code: number; stdout: string; stderr: string };
        expect(failure.code).toBe(1);
        expect(failure.stdout).toContain('"evaluated": 2');
        expect(failure.stderr).toContain("SCAN START Scope archive");
        expect(failure.stderr).toContain("BATCH 3 runs");
        expect(failure.stderr).toContain("RUN FAILED acme-run-missing");
        expect(failure.stderr).toContain("ELEMENT START acme-run-archive");
        expect(failure.stderr).toContain("RUN COMPLETED acme-run-second");
        expect(failure.stderr).toContain("Failure details:");
        expect(failure.stderr).not.toMatch(ANSI_PATTERN);
        expect(failure.stderr).not.toMatch(/\u001b\[/);
      }
      const files = (await (await import("node:fs/promises")).readdir(output)).sort();
      expect(files).toEqual([
        "acme-request-1--acme-run-archive.json",
        "acme-request-2--acme-run-second.json",
        "acme-request-3--acme-run-missing.json",
      ]);
      expect(JSON.parse(await readFile(join(output, files[2]), "utf8")))
        .toMatchObject({
          schema_version: "scope/taxonome-run-error/v1",
          stage: "parse",
        });

      const before = await Promise.all(files.slice(0, 2).map(async file =>
        (await (await import("node:fs/promises")).stat(join(output, file))).mtimeMs
      ));
      await expect(runCli([
        ...common,
        "--output-dir",
        output,
      ], example)).rejects.toMatchObject({
        code: 1,
        stdout: expect.stringContaining('"resumed": 2'),
        stderr: expect.stringContaining("RUN RESUMED acme-run-archive"),
      });
      const after = await Promise.all(files.slice(0, 2).map(async file =>
        (await (await import("node:fs/promises")).stat(join(output, file))).mtimeMs
      ));
      expect(after).toEqual(before);

      try {
        await runCli([
          "readout",
          output,
          "--taxonomy",
          "taxonomy.yaml",
          "--inputs",
          archive,
          "--plugin",
          pluginSpecifier,
        ], example);
        throw new Error("Expected mixed-root partial readout to exit nonzero");
      } catch (error) {
        const failure = error as {
          code: number;
          stdout: string;
          stderr: string;
        };
        expect(failure.code).toBe(1);
        expect(failure.stderr).toBe("");
        const report = JSON.parse(failure.stdout);
        expect(report.groups).toHaveLength(1);
        expect(report.failed_runs).toEqual([
          expect.objectContaining({
            root: "acme-request-3",
            stage: "parse",
          }),
        ]);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("cancels archive scanning on SIGINT with plain progress and exit 130", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taxonome-scan-cancel-"));
    try {
      const archive = join(directory, "runs.tar.gz");
      await createMultiRootArchive(archive, 8 * 1024 * 1024);
      const child = spawn(process.execPath, [
        "--conditions=source",
        "--import",
        "tsx",
        fileURLToPath(new URL("./index.ts", import.meta.url)),
        "run",
        archive,
        "--taxonomy",
        "taxonomy.yaml",
        "--plugin",
        pluginSpecifier,
        "--elements",
        "acme-retry-loop",
        "--output-dir",
        join(directory, "results"),
        "--json",
      ], {
        cwd: example,
        env: childEnvironment({ FORCE_COLOR: "1" }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      let signalled = false;
      child.stderr.on("data", chunk => {
        stderr += chunk.toString();
        if (!signalled && stderr.includes("SCAN START")) {
          signalled = true;
          child.kill("SIGINT");
        }
      });
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        resolve => child.on("exit", (code, signal) => resolve({ code, signal })),
      );
      expect(signalled).toBe(true);
      expect(exit).toEqual({ code: 130, signal: null });
      expect(stderr).toContain("SCAN CANCELLED");
      expect(stderr).toContain("taxonome: run cancelled");
      expect(stderr).not.toMatch(ANSI_PATTERN);
      expect(stderr).not.toMatch(/\u001b\[/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
        "--json",
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
        "--inputs",
        "inputs/run.atif.json",
        "--plugin",
        pluginSpecifier,
        "--markdown",
        markdownPath,
      ], example);
      const report = JSON.parse(stdout);
      expect(report.schema_version).toBe("scope/taxonomy-readout/v1");
      expect(report.groups[0].behaviors.find(
        (behavior: { element_id: string }) =>
          behavior.element_id === "acme-retry-loop",
      )).toMatchObject({
        distinct_runs: 1,
        occurrences: 1,
      });

      expect(await readFile(markdownPath, "utf8")).toContain(
        "Recovered Retry Loop",
      );

      evaluated.results[0] = {
        ...(evaluated.results[0] as Record<string, unknown>),
        taxonomy: {
          id: "tampered",
          version: "1.0.0",
          digest: "0".repeat(64),
        },
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
        "--inputs",
        "inputs/run.atif.json",
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

  it("builds a partial collection readout and exits nonzero for persisted run errors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taxonome-readout-errors-"));
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
        "--json",
      ], example);
      await writeFile(join(directory, "success.json"), run.stdout);
      await writeFile(join(directory, "error.json"), JSON.stringify({
        schema_version: "scope/taxonome-run-error/v1",
        root: "request-failed",
        request_id: "request-failed",
        stage: "parse",
        error: "missing retained evidence",
      }));
      await writeFile(join(directory, "ignored.json"), JSON.stringify({
        unrelated: true,
      }));

      try {
        await runCli([
          "readout",
          directory,
          "--taxonomy",
          "taxonomy.yaml",
          "--inputs",
          "inputs/run.atif.json",
          "--plugin",
          pluginSpecifier,
        ], example);
        throw new Error("Expected partial readout to exit nonzero");
      } catch (error) {
        const failure = error as { code: number; stdout: string; stderr: string };
        expect(failure.code).toBe(1);
        expect(failure.stderr).toBe("");
        const report = JSON.parse(failure.stdout);
        expect(report.groups).toHaveLength(1);
        expect(report.failed_runs).toEqual([
          expect.objectContaining({ root: "request-failed" }),
        ]);
      }
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
      "--json",
    ], {
      cwd: root,
      env: childEnvironment({ FORCE_COLOR: "1" }),
    });

    expect(stdout).not.toMatch(ANSI_PATTERN);
    expect(() => JSON.parse(stdout) as unknown).not.toThrow();
    expect(stderr).toContain(
      "BATCH 1 runs :: 1 elements :: concurrency=1",
    );
    expect(stderr).toContain("RUN COMPLETED input");
    expect(stderr).not.toMatch(ANSI_PATTERN);
  });

  it("exposes unified package eval help without credentials or model calls", async () => {
    const { stdout, stderr } = await runCatalogEvaluation(["--help"]);

    expect(stdout).toBe("");
    expect(stderr).toContain("Usage: taxonome eval");
    expect(stderr).toContain("--inputs <pattern>");
    expect(stderr).toContain("--ground-truth <pattern>");
    expect(stderr).toContain("--element <id>");
    expect(stderr).toContain("--concurrency <n>");
    expect(stderr).toContain("--json");
  });

  it("keeps redirected help/errors plain and accessible", async () => {
    const help = await runCli(["run", "--help"]);
    expect(help.stdout).toBe("");
    expect(help.stderr).toContain("Usage:");
    expect(help.stderr).toContain("--taxonomy");
    expect(help.stderr).toContain("--files-from <path>");
    expect(help.stderr).toContain("--null");
    expect(help.stderr).toContain("--output-dir <path>");
    expect(help.stderr).toContain("--concurrency <n>");
    expect(help.stderr).toContain("--force");
    expect(help.stderr).not.toContain("--context");
    expect(help.stderr).not.toMatch(ANSI_PATTERN);

    const readoutHelp = await runCli(["readout", "--help"]);
    expect(readoutHelp.stderr).toContain("--taxonomy <path>");
    expect(readoutHelp.stderr).toContain("--inputs <pattern>");

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
