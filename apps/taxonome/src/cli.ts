// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Command, Option } from "commander";
import { parse as parseYaml, parseDocument, stringify as stringifyYaml } from "yaml";
import {
  buildReadoutV2,
  ATIF_INGESTION_POLICY_HASH,
  evaluate,
  evaluateElement,
  loadAtifInputs,
  createAtifInputOrigin,
  loadReadoutCollection,
  loadReadoutInputs,
  loadPlugins,
  loadTaxonomy,
  readoutMarkdownV2,
  type Evaluation,
  type AtifInputOrigin,
  type NormalizedTaxonomy,
  type PromptExecutor,
  type ScopeAtif,
} from "taxonomy-engine";
import {
  createAgentBehaviorHandlerRegistry,
} from "ax-taxonomy";
import {
  checkEvaluationInput,
  loadEvaluationData,
  type EvaluationInput,
} from "taxonomy-engine/evaluation-inputs";
import type { CopilotTransport } from "taxonomy-engine/copilot";
import {
  configureTaxonomeHelp,
  createTaxonomeStyle,
  type TaxonomeStyle,
} from "./style.js";
import {
  renderEvalHuman,
  renderEvalCompactHuman,
  renderOptimizeHuman,
  renderRunHuman,
  type EvaluationResultRow,
} from "./output.js";
import {
  planEvaluationJobs,
  runEvaluationJobs,
  summarizeEvaluationOutcomes,
  type EvaluationJobOutcome,
} from "./evaluation-jobs.js";
import { EvaluationDashboard } from "./evaluation-dashboard.js";
import { OptimizationDashboard } from "./optimization-dashboard.js";
import { PromptWorkerRuntimes } from "./prompt-worker-runtimes.js";
import { installEvaluationCancellation } from "./evaluation-cancellation.js";
import {
  BATCH_ERROR_SCHEMA_VERSION,
  ArchiveScanProgressRenderer,
  planRunBatch,
  redactRunBatchError,
  runBatchAtifDiagnostic,
  runBatchFilename,
  runBatchArchiveRoot,
  RunBatchDashboard,
  runElementsSequentially,
  runRootJobs,
  scopedBatchRunId,
  writeRunBatchRecordAtomic,
  type RunBatchError,
  type RunBatchSource,
  type RunBatchSuccess,
} from "./run-batch.js";
import {
  readRunInputSelections,
  type RunInputSelection,
} from "./run-inputs.js";

interface ExecutionOptions {
  /** Required taxonomy YAML path. */
  taxonomy: string;
  /** Explicit trusted compiled JavaScript plugin selections. */
  plugin: string[];
  /** Exact Copilot model ID; defaults to the pinned spike model. */
  model: string;
  /** Emit the complete machine-readable JSON shape instead of human text. */
  json?: boolean;
  /** Repeatable standard element YAML overrides. */
  elementOverride: string[];
}

interface RunOptions extends ExecutionOptions {
  /** Repeatable parser storage used to reject duplicate --files-from flags. */
  filesFrom: string[];
  /** Parse --files-from records as NUL-delimited paths. */
  null?: boolean;
  /** Comma-separated element IDs; defaults to every loaded taxonomy element. */
  elements?: string;
  /** Required destination for multi-root archives. */
  outputDir?: string;
  /** Root worker count from 1 through 16; defaults to 4. */
  concurrency: string;
  /** Recompute compatible successful outputs. */
  force?: boolean;
}

interface EvalOptions extends ExecutionOptions {
  /** Repeatable JSONL input file/glob patterns. */
  inputs: string[];
  /** Repeatable ground-truth JSON file/glob patterns. */
  groundTruth: string[];
  /** Input split or `all`; defaults to `all`. */
  split?: string;
  /** Repetition count from 1 through 10, encoded by Commander as text. */
  samples: string;
  /** Global worker count from 1 through 16; defaults to 4. */
  concurrency: string;
  /** Optional stable element ID filter. */
  element: string[];
}

interface OptimizeOptions extends ExecutionOptions {
  /** Repeatable disjoint train/validation/test JSONL input patterns. */
  inputs: string[];
  /** Repeatable reviewed ground-truth JSON patterns. */
  groundTruth: string[];
  /** Optional repeatable prompt element IDs; omitted selects every prompt element. */
  element: string[];
  /** New candidate directory; mutually exclusive with in-place publication. */
  outputDir?: string;
  /** Atomically replace writable local referenced element YAML. */
  inPlace?: boolean;
  /** Existing selected optimized YAML to publish exactly with --in-place. */
  fromCandidate: string[];
  /** Ax metric-evaluation cap from 1 through 100; default 48. */
  maxMetricCalls: string;
}

interface ReadoutOptions {
  /** Required taxonomy YAML used to verify result digest and role contracts. */
  taxonomy: string;
  /** Repeatable exact ATIF or Scope archive evidence selections. */
  inputs: string[];
  /** Explicit plugins needed only when verifying a custom deterministic taxonomy. */
  plugin: string[];
  /** Optional Markdown destination; JSON always remains on stdout. */
  markdown?: string;
}

interface LoadedExecution {
  /** Loaded taxonomy and resolved deterministic handlers. */
  taxonomy: NormalizedTaxonomy;
  /** Lazily initialized prompt executor. */
  executor?: PromptExecutor;
  /** Closes an initialized SDK transport. */
  close(): Promise<void>;
  /** Whether an initialized prompt transport can accept another job. */
  healthy(): boolean;
  /** Reproducibility metadata for the loaded taxonomy and prompt runtime. */
  metadata(): Promise<Record<string, unknown>>;
}

/** Creates one lazy executor while preserving cancellation through the wrapper. */
export function createLazyPromptExecutor(
  start: () => Promise<PromptExecutor>,
): PromptExecutor {
  let starting: Promise<PromptExecutor> | undefined;
  return {
    async evaluate(element, input, signal) {
      starting ??= start();
      return (await starting).evaluate(element, input, signal);
    },
  };
}

interface PreparedOverrides {
  /** Parsed standard element YAML keyed by exact element ID. */
  values: ReadonlyMap<string, unknown>;
  /** Semantic override hashes exposed in runtime metadata. */
  hashes: Readonly<Record<string, string>>;
}

/** Collects repeatable Commander option values without scanning or discovery. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** Parses a comma-separated element list without accepting empty IDs. */
function parseElementIds(value: string): string[] {
  const ids = value.split(",").map(id => id.trim());
  if (ids.some(id => !id)) throw new Error("--elements contains an empty ID");
  return ids;
}

/** Adds taxonomy, plugin, model, and element override options. */
function addExecutionOptions(command: Command): Command {
  return command
    .requiredOption("--taxonomy <path>", "Taxonomy YAML manifest")
    .addOption(new Option("--plugin <specifier>", "Trusted compiled JS plugin path or installed package").argParser(collect).default([]))
    .option("--model <id>", "Copilot model (pinned for comparisons)", "gpt-5.6-sol-fast")
    .option("--json", "Emit complete machine-readable JSON")
    .addOption(
      new Option(
        "--element-override <path>",
        "Repeatable complete optimized element YAML override",
      ).argParser(collect).default([]),
    );
}

/** Loads built-ins, explicit plugins, and the authored taxonomy from invocation cwd. */
async function loadExecutionTaxonomy(
  options: Pick<ExecutionOptions, "taxonomy" | "plugin" | "elementOverride">,
): Promise<NormalizedTaxonomy> {
  // The CLI explicitly composes the shipped catalog before trusted plugins.
  const handlers = createAgentBehaviorHandlerRegistry();
  await loadPlugins(options.plugin, process.cwd(), handlers);
  const overrides = await prepareElementOverrides(options.elementOverride);
  return loadTaxonomy(options.taxonomy, {
    handlers,
    elementOverrides: overrides.values,
  });
}

/** Loads complete standard element YAML overrides without model initialization. */
async function prepareElementOverrides(
  paths: readonly string[],
): Promise<PreparedOverrides> {
  const values = new Map<string, unknown>();
  const hashes: Record<string, string> = {};
  const { semanticHash } = await import("taxonomy-engine/optimization-v2");
  for (const path of paths) {
    const value = parseYaml(await readFile(path, "utf8")) as unknown;
    const elementId = typeof value === "object" && value && "id" in value
      ? String((value as { id: unknown }).id)
      : "";
    if (!elementId) {
      throw new Error(`Element override '${path}' is missing id`);
    }
    if (values.has(elementId)) {
      throw new Error(`Duplicate element override for '${elementId}'`);
    }
    values.set(elementId, value);
    hashes[elementId] = semanticHash(value);
  }
  return { values, hashes };
}

interface ElementSourcePath {
  id: string;
  path: string;
}

/** Resolves writable local element files from explicit taxonomy path references. */
async function taxonomyElementSourcePaths(
  taxonomyPath: string,
): Promise<Map<string, ElementSourcePath>> {
  const manifestPath = await realpath(resolve(taxonomyPath));
  const document = parseDocument(await readFile(manifestPath, "utf8"), {
    uniqueKeys: true,
  });
  const value = document.toJS() as {
    elements?: Array<{ path?: unknown } | Record<string, unknown>>;
  };
  const result = new Map<string, ElementSourcePath>();
  for (const entry of value.elements ?? []) {
    if (!entry || typeof entry !== "object" || typeof entry.path !== "string") {
      continue;
    }
    const path = await realpath(resolve(dirname(manifestPath), entry.path));
    const element = parseYaml(await readFile(path, "utf8")) as {
      id?: unknown;
    };
    if (typeof element.id === "string") {
      result.set(element.id, { id: element.id, path });
    }
  }
  return result;
}

function optimizedYaml(value: unknown): string {
  return stringifyYaml(value, { lineWidth: 100 });
}

function displayPath(path: string): string {
  const value = relative(process.cwd(), path);
  return value && !value.startsWith("..") ? value : path;
}

async function writeCandidateSet(input: {
  outputDir: string;
  results: ReadonlyArray<{
    elementId: string;
    element: unknown;
    manifest: unknown;
  }>;
}): Promise<Array<{ elementId: string; yaml: string; manifest: string }>> {
  const destination = resolve(input.outputDir);
  const stage = await mkdtemp(join(tmpdir(), "taxonome-optimize-"));
  const published: string[] = [];
  try {
    await mkdir(destination, { recursive: true });
    const paths = input.results.map(result => ({
      elementId: result.elementId,
      yaml: join(destination, `${result.elementId}.optimized.yaml`),
      manifest: join(
        destination,
        `${result.elementId}.optimization.manifest.json`,
      ),
      stagedYaml: join(stage, `${result.elementId}.optimized.yaml`),
      stagedManifest: join(
        stage,
        `${result.elementId}.optimization.manifest.json`,
      ),
      element: result.element,
      manifestValue: result.manifest,
    }));
    for (const path of paths) {
      for (const target of [path.yaml, path.manifest]) {
        try {
          await stat(target);
          throw new Error(`Refusing to overwrite '${target}'`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      await writeFile(path.stagedYaml, optimizedYaml(path.element), "utf8");
      await writeFile(
        path.stagedManifest,
        `${JSON.stringify(path.manifestValue, null, 2)}\n`,
        "utf8",
      );
    }
    for (const path of paths) {
      await rename(path.stagedYaml, path.yaml);
      published.push(path.yaml);
      await rename(path.stagedManifest, path.manifest);
      published.push(path.manifest);
    }
    return paths.map(({ elementId, yaml, manifest }) => ({
      elementId,
      yaml,
      manifest,
    }));
  } catch (error) {
    await Promise.all(published.map(path => rm(path, { force: true })));
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function writeInPlaceSet(input: {
  taxonomyPath: string;
  results: ReadonlyArray<{
    elementId: string;
    element: { implementation: { prompt: string } };
    manifest: unknown;
  }>;
}): Promise<Array<{ elementId: string; yaml: string; manifest: string }>> {
  const sources = await taxonomyElementSourcePaths(input.taxonomyPath);
  const stage = await mkdtemp(join(tmpdir(), "taxonome-in-place-"));
  const backups = new Map<string, Buffer | undefined>();
  const published: string[] = [];
  try {
    const paths = input.results.map(result => {
      const source = sources.get(result.elementId);
      if (!source) {
        throw new Error(
          `--in-place requires writable local path reference for '${result.elementId}'`,
        );
      }
      const manifest = join(
        dirname(source.path),
        `${result.elementId}.optimization.manifest.json`,
      );
      return {
        ...result,
        yaml: source.path,
        manifest,
        stagedYaml: join(stage, `${result.elementId}.yaml`),
        stagedManifest: join(
          stage,
          `${result.elementId}.optimization.manifest.json`,
        ),
      };
    });
    for (const path of paths) {
      const source = await readFile(path.yaml, "utf8");
      const document = parseDocument(source, { uniqueKeys: true });
      document.setIn(
        ["implementation", "prompt"],
        path.element.implementation.prompt,
      );
      await writeFile(path.stagedYaml, document.toString(), "utf8");
      await writeFile(
        path.stagedManifest,
        `${JSON.stringify(path.manifest, null, 2)}\n`,
        "utf8",
      );
      backups.set(path.yaml, Buffer.from(source));
      try {
        backups.set(path.manifest, await readFile(path.manifest));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        backups.set(path.manifest, undefined);
      }
    }
    for (const path of paths) {
      await rename(path.stagedYaml, path.yaml);
      published.push(path.yaml);
      await rename(path.stagedManifest, path.manifest);
      published.push(path.manifest);
    }
    return paths.map(({ elementId, yaml, manifest }) => ({
      elementId,
      yaml,
      manifest,
    }));
  } catch (error) {
    for (const path of published.reverse()) {
      const backup = backups.get(path);
      if (backup === undefined) await rm(path, { force: true });
      else await writeFile(path, backup);
    }
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/** Defers SDK initialization until an eligible prompt element reaches execution. */
async function createRuntime(
  options: ExecutionOptions,
  taxonomy: NormalizedTaxonomy,
  selected: readonly string[],
  preparedOverrides?: PreparedOverrides,
): Promise<LoadedExecution> {
  const promptIds = selected.filter(id =>
    taxonomy.elementById.get(id)?.implementation.type === "prompt"
  );
  const overrides = preparedOverrides ??
    await prepareElementOverrides(options.elementOverride);
  if (!promptIds.length) {
    return {
      taxonomy,
      close: async () => {},
      healthy: () => true,
      metadata: async () => ({
        taxonomy: {
          id: taxonomy.id,
          version: taxonomy.version,
          digest: taxonomy.digest,
        },
        strategy: "deterministic",
      }),
    };
  }

  let transport: CopilotTransport | undefined;
  let executor: PromptExecutor | undefined;
  let startFailed = false;

  /** Creates one SDK transport after element overrides have been validated. */
  async function start(): Promise<PromptExecutor> {
    const {
      copilotAI,
      openCopilotTransport,
      taxonomyPromptExecutor,
    } = await import("taxonomy-engine/copilot");
    transport = await openCopilotTransport(options.model);
    executor = taxonomyPromptExecutor(copilotAI(transport, options.model));
    return executor;
  }

  const lazyExecutor = createLazyPromptExecutor(async () => {
    try {
      return await start();
    } catch (error) {
      startFailed = true;
      throw error;
    }
  });
  return {
    taxonomy,
    executor: lazyExecutor,
    close: async () => {
      await transport?.close();
    },
    healthy: () => transport?.isHealthy?.() ?? !startFailed,
    metadata: async () => {
      return {
        taxonomy: {
          id: taxonomy.id,
          version: taxonomy.version,
          digest: taxonomy.digest,
        },
        model: options.model,
        initialized: Boolean(transport),
        element_override_hashes: overrides.hashes,
        atif_ingestion_policy_hash: ATIF_INGESTION_POLICY_HASH,
      };
    },
  };
}

/** Builds explicit readout grouping metadata from the Scope ATIF extension. */
function readoutRunFromAtif(
  atif: ScopeAtif,
  results: Evaluation[],
) {
  const scope = atif.extra?.scope;
  const run = scope?.run;
  const scenarioId = run?.scenario_id ?? "unknown-scenario";
  const profileId = run?.profile_id ?? "unknown-profile";
  const identity = results[0]?.input.sha256.slice(0, 12) ?? "unknown";
  return {
    run: {
      id: run?.id ?? atif.trajectory_id ?? atif.session_id ?? `atif-${identity}`,
      scenario: {
        id: scenarioId,
        label: run?.scenario_label ?? scenarioId,
        ...(scope?.task ? { task: scope.task } : {}),
      },
      profile: {
        id: profileId,
        label: run?.profile_label ?? profileId,
      },
    },
    results,
  };
}

/** Writes one pretty JSON document to stdout without diagnostic ANSI styling. */
const emitJson = (value: unknown) =>
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

/**
 * Selects explicit machine JSON or the command's concise human rendering.
 *
 * @param json - Whether the caller requested `--json`.
 * @param value - Complete compatibility-preserving machine value.
 * @param human - Concise human text ending with a newline.
 */
function emitCommandOutput(json: boolean | undefined, value: unknown, human: string) {
  if (json) {
    emitJson(value);
  } else {
    process.stdout.write(human);
  }
}

/** Loads every listed local input before starting any prompt worker. */
async function loadListedRunSources(
  selections: readonly RunInputSelection[],
  taxonomy: NormalizedTaxonomy,
  controller: AbortController,
  style: TaxonomeStyle,
  json: boolean,
): Promise<RunBatchSource[]> {
  const sources: RunBatchSource[] = [];
  for (const selection of selections) {
    if (controller.signal.aborted) {
      throw new Error("run cancelled");
    }
    const baseOrigin: AtifInputOrigin = {
      selected_input: selection.canonical,
    };
    if (selection.error) {
      sources.push({
        root: "input",
        label: displayListedInput(selection),
        origin: baseOrigin,
        fingerprint: createHash("sha256")
          .update(selection.canonical)
          .digest("hex"),
        error: selection.error,
      });
      continue;
    }

    const scanProgress = new ArchiveScanProgressRenderer(
      process.stderr,
      style,
      json,
    );
    try {
      const loaded = await loadAtifInputs(
        selection.canonical,
        taxonomy,
        {},
        {
          signal: controller.signal,
          onProgress: progress => scanProgress.update(progress),
        },
      );
      scanProgress.finalize("complete");
      for (const source of loaded) {
        const origin = createAtifInputOrigin(selection.canonical, source);
        sources.push({
          ...source,
          origin,
          label: displayListedInput(selection, origin.archive_root),
        });
      }
    } catch (error) {
      scanProgress.finalize(
        controller.signal.aborted ? "cancelled" : "error",
      );
      if (controller.signal.aborted) throw error;
      sources.push({
        root: "input",
        label: displayListedInput(selection),
        origin: baseOrigin,
        fingerprint: createHash("sha256")
          .update(selection.canonical)
          .digest("hex"),
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  return sources;
}

function displayListedInput(
  selection: RunInputSelection,
  archiveRoot?: string,
): string {
  const escaped = JSON.stringify(selection.original);
  return archiveRoot ? `${escaped}#${archiveRoot}` : escaped;
}

/** Rejects list/input paths that an atomic batch record would overwrite. */
async function assertListOutputSafety(
  outputDir: string,
  sources: readonly RunBatchSource[],
  listSource: string,
): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  const canonicalOutputDir = await realpath(outputDir);
  const protectedPaths = new Set(
    sources.flatMap(source =>
      source.origin ? [source.origin.selected_input] : []
    ),
  );
  if (listSource !== "-") {
    const listPath = isAbsolute(listSource)
      ? listSource
      : resolve(process.cwd(), listSource);
    protectedPaths.add(await realpath(listPath));
  }
  for (const source of sources) {
    const outputPath = resolve(
      canonicalOutputDir,
      runBatchFilename(source),
    );
    if (protectedPaths.has(outputPath)) {
      throw new Error(
        `Batch output would overwrite a selected input or path list: ${outputPath}`,
      );
    }
  }
}

/** Executes one plain ATIF or single archive root with run-centric progress. */
async function runSingleSource(
  options: RunOptions,
  taxonomy: NormalizedTaxonomy,
  selected: readonly string[],
  source: RunBatchSource,
  controller: AbortController,
  isInterrupted: () => boolean,
  style: TaxonomeStyle,
): Promise<void> {
  const selectedElements = selected.map(id => {
    const element = taxonomy.elementById.get(id)!;
    return {
      id,
      label: element.label,
      implementation: element.implementation.type,
    };
  });
  const dashboard = new RunBatchDashboard({
    taxonomy: { id: taxonomy.id, version: taxonomy.version },
    concurrency: 1,
    elements: selectedElements,
    rows: [{
      sequence: 0,
      root: source.root,
      ...(source.requestId ? { requestId: source.requestId } : {}),
      ...(source.runId ? { runId: source.runId } : {}),
      initialStatus: source.error ? "failed" : "waiting",
    }],
    style,
    stream: process.stderr,
    json: Boolean(options.json),
  });
  let runtime: LoadedExecution | undefined;
  let settled: "completed" | "failed" | "cancelled" | undefined =
    source.error ? "failed" : undefined;
  dashboard.start();

  try {
    if (source.error) throw source.error;
    if (!source.atif) {
      throw new Error(`Input root '${source.root}' has no normalized ATIF`);
    }
    const atif = source.atif;

    runtime = await createRuntime(options, taxonomy, selected);
    dashboard.startRun(0);
    const sequence = await runElementsSequentially<Evaluation>(
      selectedElements,
      async element => {
        const archiveRoot = runBatchArchiveRoot(source);
        const evaluation = await evaluateElement(
          {
            atif,
            ...(source.provenance
              ? { atif_provenance: source.provenance }
              : {}),
            taxonomy,
          },
          element.id,
          runtime?.executor,
          controller.signal,
          {
            ...(archiveRoot ? { archiveRoot } : {}),
            requestId: source.requestId,
            runId: source.runId,
          },
        );
        return {
          value: evaluation,
          ...(evaluation.status === "failed"
            ? {
              failure:
                `${element.label} (${element.id}): ` +
                `${evaluation.error.code}: ${evaluation.error.message}`,
            }
            : {}),
        };
      },
      {
        onStart: element => dashboard.startElement(0, element),
        onComplete: (element, outcome) =>
          dashboard.completeElement(0, element, outcome),
      },
      controller.signal,
    );
    const results = sequence.values;
    const output = {
      ...readoutRunFromAtif(atif, results),
      metadata: {
        ...(await runtime.metadata()),
        ...(source.provenance
          ? { atif_provenance: source.provenance }
          : {}),
      },
    };
    settled = sequence.cancelled
      ? "cancelled"
      : sequence.failures.length
        ? "failed"
        : "completed";
    dashboard.completeRun(0, settled);
    dashboard.finalize();

    emitCommandOutput(
      options.json,
      output,
      renderRunHuman(
        { id: taxonomy.id, version: taxonomy.version },
        output.run,
        results,
      ),
    );
    if (settled !== "completed") {
      process.exitCode = sequence.cancelled || isInterrupted() ? 130 : 1;
    }
  } catch (error) {
    if (!settled) {
      settled = controller.signal.aborted ? "cancelled" : "failed";
      dashboard.completeRun(0, settled);
    }
    if (controller.signal.aborted) {
      const cancellation = new Error("run cancelled") as Error & {
        exitCode: number;
      };
      cancellation.exitCode = 130;
      throw cancellation;
    }
    throw error;
  } finally {
    dashboard.finalize();
    await runtime?.close();
  }
}

/** Executes one multi-root archive with run-bounded, element-sequential workers. */
async function runMultiArchive(
  options: RunOptions & { outputDir: string },
  taxonomy: NormalizedTaxonomy,
  selected: readonly string[],
  sources: readonly RunBatchSource[],
  concurrency: number,
  controller: AbortController,
  isInterrupted: () => boolean,
  style: TaxonomeStyle,
): Promise<void> {
  const overrides = await prepareElementOverrides(options.elementOverride);
  const expected = {
    taxonomy,
    taxonomy_digest: taxonomy.digest,
    element_ids: [...selected],
    model: options.model,
    element_override_hashes: overrides.hashes,
    atif_ingestion_policy_hash: ATIF_INGESTION_POLICY_HASH,
  };
  const planned = await planRunBatch(
    sources,
    options.outputDir,
    expected,
    Boolean(options.force),
  );
  const promptRuntimes = new PromptWorkerRuntimes(() =>
    createRuntime(options, taxonomy, selected, overrides)
  );
  const resumedSequences = new Set(planned.resumed.map(job => job.sequence));
  const selectedElements = selected.map(id => {
    const element = taxonomy.elementById.get(id)!;
    return {
      id,
      label: element.label,
      implementation: element.implementation.type,
    };
  });
  const dashboard = new RunBatchDashboard({
    taxonomy: { id: taxonomy.id, version: taxonomy.version },
    concurrency,
    elements: selectedElements,
    rows: sources.map((source, sequence) => ({
      sequence,
      root: source.label ?? source.root,
      ...(!source.origin && source.requestId
        ? { requestId: source.requestId }
        : {}),
      ...(!source.origin && source.runId ? { runId: source.runId } : {}),
      initialStatus: source.error
        ? "failed"
        : resumedSequences.has(sequence)
          ? "resumed"
          : "waiting",
    })),
    style,
    stream: process.stderr,
    json: Boolean(options.json),
  });
  dashboard.start();

  let cleanupFailures: unknown[] = [];
  const runFailures = new Map<number, string[]>();
  for (const [sequence, source] of sources.entries()) {
    if (source.error) {
      runFailures.set(sequence, [
        `parse: ${redactRunBatchError(source.error)}`,
      ]);
    }
  }
  const executableJobs = planned.jobs.filter(job => !job.error && job.atif);
  for (const job of planned.jobs.filter(job => job.error || !job.atif)) {
    try {
      await writeRunBatchRecordAtomic(job.outputPath, {
        schema_version: BATCH_ERROR_SCHEMA_VERSION,
        root: job.root,
        ...(job.requestId ? { request_id: job.requestId } : {}),
        ...(job.runId ? { run_id: job.runId } : {}),
        ...(job.origin ? { input_origin: job.origin } : {}),
        ...(job.provenance
          ? { atif_provenance: job.provenance }
          : {}),
        stage: "parse",
        error: redactRunBatchError(job.error ?? "Missing normalized ATIF"),
        ...(runBatchAtifDiagnostic(job.error)
          ? { atif_diagnostic: runBatchAtifDiagnostic(job.error) }
          : {}),
      });
    } catch (error) {
      cleanupFailures.push(error);
    }
  }

  try {
    const outcomes = await runRootJobs(
      executableJobs,
      concurrency,
      async (job, workerId) => {
        if (controller.signal.aborted) {
          dashboard.completeRun(job.sequence, "cancelled");
          return;
        }
        const atif = job.atif!;

        dashboard.startRun(job.sequence);
        let initialized = false;
        const sequence = await runElementsSequentially<Evaluation>(
          selectedElements,
          async element => {
            let runtime: LoadedExecution | undefined;
            try {
              runtime = element.implementation === "prompt"
                ? await promptRuntimes.get(workerId)
                : undefined;
              const archiveRoot = runBatchArchiveRoot(job);
              const evaluation = await evaluateElement(
                {
                  atif,
                  ...(job.provenance
                    ? { atif_provenance: job.provenance }
                    : {}),
                  taxonomy,
                },
                element.id,
                runtime?.executor,
                controller.signal,
                {
                  ...(archiveRoot ? { archiveRoot } : {}),
                  requestId: job.requestId,
                  runId: job.runId,
                },
              );
              if (runtime && (await runtime.metadata()).initialized === true) {
                initialized = true;
              }
              if (evaluation.status === "failed") {
                return {
                  value: evaluation,
                  failure:
                    `${element.label} (${element.id}): ` +
                    `${evaluation.error.code}: ${evaluation.error.message}`,
                };
              }

              const result = evaluation.result;
              return {
                value: evaluation,
              };
            } finally {
              if (runtime && !runtime.healthy()) {
                try {
                  await promptRuntimes.replaceIfPoisoned(workerId);
                } catch (error) {
                  cleanupFailures.push(error);
                }
              }
            }
          },
          {
            onStart: element => {
              dashboard.startElement(job.sequence, element);
            },
            onComplete: (element, outcome) => {
              dashboard.completeElement(job.sequence, element, outcome);
            },
          },
          controller.signal,
        );
        const results = sequence.values;
        const failures = sequence.failures.map(redactRunBatchError);

        if (sequence.cancelled) {
          const message = "run cancelled";
          runFailures.set(job.sequence, [...failures, message]);
          await writeRunBatchRecordAtomic(job.outputPath, {
            schema_version: BATCH_ERROR_SCHEMA_VERSION,
            root: job.root,
            ...(job.requestId ? { request_id: job.requestId } : {}),
            ...(job.runId ? { run_id: job.runId } : {}),
            ...(job.origin ? { input_origin: job.origin } : {}),
            ...(job.provenance
              ? { atif_provenance: job.provenance }
              : {}),
            stage: "cancelled",
            error: message,
          });
          dashboard.completeRun(job.sequence, "cancelled");
          return;
        }

        if (failures.length) {
          runFailures.set(job.sequence, failures);
          await writeRunBatchRecordAtomic(job.outputPath, {
            schema_version: BATCH_ERROR_SCHEMA_VERSION,
            root: job.root,
            ...(job.requestId ? { request_id: job.requestId } : {}),
            ...(job.runId ? { run_id: job.runId } : {}),
            ...(job.origin ? { input_origin: job.origin } : {}),
            ...(job.provenance
              ? { atif_provenance: job.provenance }
              : {}),
            stage: "evaluation",
            error: redactRunBatchError(failures.join("; ")),
          });
          dashboard.completeRun(job.sequence, "failed");
          return;
        }

        try {
          const output: RunBatchSuccess = {
            ...readoutRunFromAtif(atif, results),
            metadata: {
              taxonomy: {
                id: taxonomy.id,
                version: taxonomy.version,
                digest: taxonomy.digest,
              },
              model: options.model,
              element_override_hashes: overrides.hashes,
              atif_ingestion_policy_hash: ATIF_INGESTION_POLICY_HASH,
              element_ids: [...selected],
              source: {
                ...(runBatchArchiveRoot(job)
                  ? {
                    archive_root: runBatchArchiveRoot(job),
                  }
                  : {}),
                ...(job.origin ? { input_origin: job.origin } : {}),
                retained_evidence_sha256: job.fingerprint,
                ...(job.requestId ? { request_id: job.requestId } : {}),
                ...(job.runId ? { run_id: job.runId } : {}),
                ...(job.origin ? { input_origin: job.origin } : {}),
                ...(job.provenance
                  ? { atif_provenance: job.provenance }
                  : {}),
              },
              initialized,
            },
          };
          output.run.id = scopedBatchRunId(output.run.id, job.origin);
          await writeRunBatchRecordAtomic(job.outputPath, output);
          dashboard.completeRun(job.sequence, "completed");
        } catch (error) {
          runFailures.set(job.sequence, [
            `output: ${redactRunBatchError(error)}`,
          ]);
          const errorRecord: RunBatchError = {
            schema_version: BATCH_ERROR_SCHEMA_VERSION,
            root: job.root,
            ...(job.requestId ? { request_id: job.requestId } : {}),
            ...(job.runId ? { run_id: job.runId } : {}),
            ...(job.provenance
              ? { atif_provenance: job.provenance }
              : {}),
            stage: "evaluation",
            error: redactRunBatchError(error),
          };
          await writeRunBatchRecordAtomic(job.outputPath, errorRecord);
          dashboard.completeRun(job.sequence, "failed");
        }
      },
      controller.signal,
    );

    for (const outcome of outcomes) {
      if (outcome.status === "cancelled") {
        if (!runFailures.has(outcome.job.sequence)) {
          runFailures.set(outcome.job.sequence, [
            "run cancelled before scheduling",
          ]);
          await writeRunBatchRecordAtomic(outcome.job.outputPath, {
            schema_version: BATCH_ERROR_SCHEMA_VERSION,
            root: outcome.job.root,
            ...(outcome.job.requestId
              ? { request_id: outcome.job.requestId }
              : {}),
            ...(outcome.job.runId ? { run_id: outcome.job.runId } : {}),
            ...(outcome.job.origin
              ? { input_origin: outcome.job.origin }
              : {}),
            ...(outcome.job.provenance
              ? { atif_provenance: outcome.job.provenance }
              : {}),
            stage: "cancelled",
            error: "run cancelled before scheduling",
          });
        }
        dashboard.completeRun(outcome.job.sequence, "cancelled");
      } else if (outcome.status === "rejected") {
        const message = redactRunBatchError(outcome.error);
        runFailures.set(outcome.job.sequence, [`runtime: ${message}`]);
        try {
          await writeRunBatchRecordAtomic(outcome.job.outputPath, {
            schema_version: BATCH_ERROR_SCHEMA_VERSION,
            root: outcome.job.root,
            ...(outcome.job.requestId
              ? { request_id: outcome.job.requestId }
              : {}),
            ...(outcome.job.runId ? { run_id: outcome.job.runId } : {}),
            ...(outcome.job.origin
              ? { input_origin: outcome.job.origin }
              : {}),
            ...(outcome.job.provenance
              ? { atif_provenance: outcome.job.provenance }
              : {}),
            stage: "evaluation",
            error: message,
          });
        } catch (writeError) {
          cleanupFailures.push(writeError);
        }
        dashboard.completeRun(outcome.job.sequence, "failed");
      }
    }
  } finally {
    cleanupFailures = cleanupFailures.concat(
      await promptRuntimes.closeAll(),
    );
  }

  const summary = dashboard.finalize();
  if (runFailures.size) {
    process.stderr.write("Failure details:\n");
    for (const [sequence, failures] of [...runFailures.entries()]
      .sort(([left], [right]) => left - right)) {
      const source = sources[sequence];
      process.stderr.write(
        `${
          source.origin
            ? source.label ?? source.root
            : source.runId ?? source.requestId ?? source.root
        }:\n`,
      );
      for (const failure of failures) {
        process.stderr.write(`  - ${failure}\n`);
      }
    }
  }
  for (const failure of cleanupFailures) {
    process.stderr.write(
      `Runtime cleanup failed: ${redactRunBatchError(failure)}\n`,
    );
  }
  emitCommandOutput(
    options.json,
    summary,
    `Result  ${summary.evaluated} evaluated • ${summary.resumed} resumed • ${summary.failed} failed` +
      `${summary.cancelled ? ` • ${summary.cancelled} cancelled` : ""} • ${summary.total} runs\n`,
  );
  if (
    summary.failed ||
    summary.cancelled ||
    isInterrupted() ||
    cleanupFailures.length
  ) {
    process.exitCode = isInterrupted() ? 130 : 1;
  }
}

/** Configures the standalone YAML/archive/plugin CLI without running it. */
export function createCli(style: TaxonomeStyle = createTaxonomeStyle()): Command {
  const cli = new Command()
    .name("taxonome")
    .description("Evaluate authored taxonomy YAML against ATIF or Scope run archives")
    .version("0.2.0");
  cli.configureOutput({
    writeOut: text => process.stderr.write(text),
    writeErr: text => process.stderr.write(text),
    getOutHasColors: () => style.enabled,
    getErrHasColors: () => style.enabled,
  });
  cli.showHelpAfterError("(use --help for command usage)");
  cli.action(() => cli.help());
  configureTaxonomeHelp(cli, style);

  const runCommand = addExecutionOptions(
    cli.command("run [input]")
      .description("Evaluate taxonomy elements for ATIF JSON or a Scope .tar.gz archive")
      .addOption(
        new Option(
          "--files-from <path>",
          "Read literal local input paths from a file, or '-' for stdin",
        ).argParser(collect).default([]),
      )
      .option("--null", "Use NUL-delimited --files-from records")
      .option("--elements <ids>", "Comma-separated element IDs; defaults to all")
      .option("--output-dir <path>", "Required output directory for multi-run archives")
      .option("--concurrency <n>", "Concurrent archive runs (1..16)", "4")
      .option("--force", "Recompute all roots instead of resuming compatible successes"),
  );
  configureTaxonomeHelp(runCommand, style);
  runCommand.action(async (
    location: string | undefined,
    options: RunOptions,
  ) => {
    if (options.filesFrom.length > 1) {
      throw new Error("--files-from may be specified only once");
    }
    const listSource = options.filesFrom[0];
    if (options.null && !listSource) {
      throw new Error("--null requires --files-from");
    }
    if (Boolean(location) === Boolean(listSource)) {
      throw new Error(
        "Provide exactly one run input source: positional [input] or --files-from",
      );
    }
    if (listSource && !options.outputDir) {
      throw new Error("--files-from requires --output-dir");
    }
    const selected = options.elements
      ? parseElementIds(options.elements)
      : undefined;
    const concurrency = Number(options.concurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
      throw new Error("--concurrency must be 1..16");
    }
    const controller = new AbortController();
    let interrupted = false;
    const removeCancellation = installEvaluationCancellation(controller, () => {
      interrupted = true;
    });
    let selections: RunInputSelection[] | undefined;
    if (listSource) {
      try {
        selections = await readRunInputSelections(listSource, {
          nullDelimited: Boolean(options.null),
          signal: controller.signal,
        });
      } catch (error) {
        removeCancellation();
        if (controller.signal.aborted) {
          const cancellation = new Error("run cancelled") as Error & {
            exitCode: number;
          };
          cancellation.exitCode = 130;
          throw cancellation;
        }
        throw error;
      }
    }
    const taxonomy = await loadExecutionTaxonomy(options);
    const selectedIds = selected ??
      taxonomy.elements.map(element => element.id);
    for (const id of selectedIds) {
      if (!taxonomy.elementById.has(id)) throw new Error(`Unknown element '${id}'`);
    }
    if (selections) {
      try {
        const sources = await loadListedRunSources(
          selections,
          taxonomy,
          controller,
          style,
          Boolean(options.json),
        );
        await assertListOutputSafety(
          options.outputDir!,
          sources,
          listSource,
        );
        await runMultiArchive(
          { ...options, outputDir: options.outputDir! },
          taxonomy,
          selectedIds,
          sources,
          concurrency,
          controller,
          () => interrupted,
          style,
        );
      } finally {
        removeCancellation();
      }
      return;
    }

    const scanProgress = new ArchiveScanProgressRenderer(
      process.stderr,
      style,
      Boolean(options.json),
    );
    let sources: Awaited<ReturnType<typeof loadAtifInputs>>;
    try {
      sources = await loadAtifInputs(location!, taxonomy, {}, {
        signal: controller.signal,
        onProgress: progress => scanProgress.update(progress),
      });
      scanProgress.finalize("complete");
    } catch (error) {
      scanProgress.finalize(controller.signal.aborted ? "cancelled" : "error");
      removeCancellation();
      if (controller.signal.aborted) {
        const cancellation = new Error("run cancelled") as Error & {
          exitCode: number;
        };
        cancellation.exitCode = 130;
        throw cancellation;
      }
      throw error;
    }
    if (sources.length === 1) {
      try {
        await runSingleSource(
          options,
          taxonomy,
          selectedIds,
          sources[0],
          controller,
          () => interrupted,
          style,
        );
      } finally {
        removeCancellation();
      }
      return;
    }

    if (!options.outputDir) {
      removeCancellation();
      throw new Error("Multi-run archives require --output-dir");
    }
    try {
      await runMultiArchive(
        { ...options, outputDir: options.outputDir },
        taxonomy,
        selectedIds,
        sources,
        concurrency,
        controller,
        () => interrupted,
        style,
      );
    } finally {
      removeCancellation();
    }
  });

  const evalCommand = addExecutionOptions(
    cli.command("eval")
      .description("Evaluate curated ATIF inputs against reviewed ground truth")
      .addOption(
        new Option(
          "--inputs <pattern>",
          "Repeatable quoted JSONL file or glob pattern",
        ).argParser(collect).default([]),
      )
      .addOption(
        new Option(
          "--ground-truth <pattern>",
          "Repeatable quoted ground-truth JSON file or glob pattern",
        ).argParser(collect).default([]),
      )
      .option("--split <split>", "train, validation, test, or all", "all")
      .option("--samples <n>", "Repeated independent passes", "1")
      .option("--concurrency <n>", "Global evaluation workers (1..16)", "4")
      .addOption(
        new Option(
          "--element <id>",
          "Evaluate one stable element on inputs that declare it",
        ).argParser(collect).default([]),
      ),
  );
  configureTaxonomeHelp(evalCommand, style);
  evalCommand.action(async (options: EvalOptions) => {
    const taxonomy = await loadExecutionTaxonomy(options);
    if (!["train", "validation", "test", "all"].includes(options.split ?? "all")) {
      throw new Error("Invalid split");
    }
    if (options.element.length > 1) {
      throw new Error("--element may be supplied only once");
    }
    const selectedElement = options.element[0];
    if (selectedElement && !taxonomy.elementById.has(selectedElement)) {
      throw new Error(
        `Unknown element '${selectedElement}'. Valid IDs: ${
          taxonomy.elements.map(element => element.id).join(", ")
        }`,
      );
    }
    const concurrency = Number(options.concurrency);
    if (
      !Number.isInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > 16
    ) {
      throw new Error("--concurrency must be 1..16");
    }

    const data = await loadEvaluationData(
      options.inputs,
      options.groundTruth,
      taxonomy,
    );
    const split = options.split ?? "all";
    const inputs = data.inputs.filter(input =>
      (split === "all" || input.split === split) &&
      (!selectedElement || input.elements.includes(selectedElement))
    );
    if (!inputs.length) throw new Error("No selected inputs");
    const sampleCount = Number(options.samples);
    if (!Number.isInteger(sampleCount) || sampleCount < 1 || sampleCount > 10) {
      throw new Error("--samples must be 1..10");
    }
    const selectedIds = new Set(
      selectedElement ? [selectedElement] : inputs.flatMap(input => input.elements),
    );
    const selectedElementUniverse = taxonomy.elements
      .map(element => element.id)
      .filter(elementId => selectedIds.has(elementId));
    const overrides = await prepareElementOverrides(options.elementOverride);
    const jobs = planEvaluationJobs(
      inputs,
      taxonomy,
      sampleCount,
      selectedElement,
    );
    const dashboard = new EvaluationDashboard({
      jobs,
      elementOrder: selectedElementUniverse,
      taxonomyId: taxonomy.id,
      taxonomyVersion: taxonomy.version,
      split,
      concurrency,
      style,
      json: Boolean(options.json),
    });
    const controller = new AbortController();
    let interrupted = false;
    const removeCancellation = installEvaluationCancellation(
      controller,
      () => {
        interrupted = true;
      },
    );
    const promptRuntimes = new PromptWorkerRuntimes(() =>
      createRuntime(
        options,
        taxonomy,
        selectedElementUniverse,
        overrides,
      )
    );
    const cleanupErrors: unknown[] = [];
    const startedAt = Date.now();
    dashboard.start();

    interface JobValue {
      evaluation: Evaluation;
      errors: string[];
      latency_ms: number;
      failed: boolean;
      cancelled: boolean;
    }

    const initializedWorkers = new Set<number>();
    let outcomes: EvaluationJobOutcome<JobValue>[] = [];
    try {
      outcomes = await runEvaluationJobs<JobValue>(
        jobs,
        concurrency,
        async (job, workerId, signal) => {
          const runtime = job.implementation === "prompt"
            ? await promptRuntimes.get(workerId)
            : undefined;
          const capturingExecutor: PromptExecutor | undefined = runtime?.executor
            ? {
              async evaluate(element, input, evaluationSignal) {
                return runtime.executor!.evaluate(
                  element,
                  input,
                  evaluationSignal,
                );
              },
            }
            : undefined;
          const startedAt = Date.now();
          const [evaluation] = await evaluate(
            {
              atif: job.input.atif,
              atif_provenance: job.input.atif_provenance,
              taxonomy,
            },
            [job.element_id],
            capturingExecutor,
            signal,
          );
          const errors = checkEvaluationInput(
            job.input,
            [evaluation],
            data.ground_truth.values,
            [job.element_id],
          );
          if (runtime && (await runtime.metadata()).initialized === true) {
            initializedWorkers.add(workerId);
          }
          if (runtime && !runtime.healthy()) {
            try {
              await promptRuntimes.replaceIfPoisoned(workerId);
            } catch (error) {
              cleanupErrors.push(error);
            }
          }
          return {
            evaluation,
            errors,
            latency_ms: Date.now() - startedAt,
            failed: errors.length > 0,
            cancelled: signal?.aborted ?? false,
          };
        },
        {
          onStart: (job, workerId) => dashboard.onStart(job, workerId),
          onComplete: outcome => dashboard.onComplete(outcome),
        },
        controller.signal,
      );
    } finally {
      removeCancellation();
      cleanupErrors.push(...await promptRuntimes.closeAll());
      dashboard.finalize();
    }

    const rowsByKey = new Map<string, EvaluationResultRow>();
    for (const outcome of outcomes) {
      const key = `${outcome.job.sample}\0${outcome.job.input.id}`;
      let row = rowsByKey.get(key);
      if (!row) {
        row = {
          input_id: outcome.job.input.id,
          input_file: outcome.job.input.source_file,
          split: outcome.job.input.split,
          sample: outcome.job.sample,
          results: [],
          errors: [],
          latency_ms: 0,
        };
        rowsByKey.set(key, row);
      }
      if (outcome.status === "fulfilled" && outcome.value) {
        row.results.push(outcome.value.evaluation);
        row.errors.push(...outcome.value.errors);
        row.latency_ms += outcome.value.latency_ms;
      } else {
        row.errors.push(
          `${outcome.job.element_id}: ${
            interrupted || outcome.status === "cancelled"
              ? "evaluation cancelled"
              : `execution failed: ${
                outcome.error instanceof Error
                  ? outcome.error.message
                  : String(outcome.error)
              }`
          }`,
        );
      }
    }
    const rows = [...rowsByKey.values()];
    const passed = rows.filter(row => !row.errors.length).length;
    const elapsedMs = Date.now() - startedAt;
    const evaluationSummary = summarizeEvaluationOutcomes(outcomes);
    const workerMetadata = await Promise.all(
      Array.from({ length: Math.min(concurrency, jobs.length) }, async (_, workerId) => ({
        worker_id: workerId,
        initialized: initializedWorkers.has(workerId),
      })),
    );
    const output = {
      passed,
      total: rows.length,
      pass_rate: passed / rows.length,
      elapsed_ms: elapsedMs,
      metadata: {
        taxonomy: {
          id: taxonomy.id,
          version: taxonomy.version,
          digest: taxonomy.digest,
        },
        model: options.model,
        concurrency,
        element_override_hashes: overrides.hashes,
        workers: workerMetadata,
      },
      rows,
      evaluations: evaluationSummary,
    };

    const failures = outcomes
      .filter(outcome =>
        outcome.status !== "fulfilled" ||
        outcome.value?.failed ||
        outcome.value?.cancelled
      )
      .sort((left, right) => {
        const elementDifference =
          selectedElementUniverse.indexOf(left.job.element_id) -
          selectedElementUniverse.indexOf(right.job.element_id);
        return elementDifference || left.job.sequence - right.job.sequence;
      });
    if (failures.length || cleanupErrors.length) {
      process.stderr.write("Failure details:\n");
      let previousElement = "";
      for (const outcome of failures) {
        if (outcome.job.element_id !== previousElement) {
          previousElement = outcome.job.element_id;
          process.stderr.write(
            `${taxonomy.elementById.get(previousElement)?.label ?? previousElement} (${previousElement}):\n`,
          );
        }
        const messages = outcome.status === "fulfilled"
          ? outcome.value?.cancelled
            ? ["evaluation cancelled"]
            : outcome.value?.errors ?? []
          : [
            interrupted || outcome.status === "cancelled"
              ? "evaluation cancelled"
              : outcome.error instanceof Error
                ? outcome.error.message
                : String(outcome.error),
          ];
        process.stderr.write(
          `  ${outcome.job.input.source_file} :: ${outcome.job.input.id} :: sample=${outcome.job.sample + 1}\n`,
        );
        for (const message of messages) {
          process.stderr.write(`    - ${message}\n`);
        }
      }
      for (const error of cleanupErrors) {
        process.stderr.write(
          `Runtime cleanup:\n    - ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      }
    }

    const detailedHuman = renderEvalHuman({
        taxonomy: { id: taxonomy.id, version: taxonomy.version },
        input_files: [...new Set(inputs.map(input => input.source_file))],
        ground_truth_files: data.ground_truth.files,
        split,
        inputs: inputs.length,
        repetitions: sampleCount,
        elapsed_ms: elapsedMs,
        elements: selectedElementUniverse.map(id => {
          const element = taxonomy.elementById.get(id);
          return {
            id,
            label: element?.label ?? id,
            implementation: element?.implementation.type ?? "prompt",
          };
        }),
        element_overrides: options.elementOverride,
        rows,
      });
    emitCommandOutput(
      options.json,
      output,
      dashboard.isInteractive()
        ? renderEvalCompactHuman(evaluationSummary, elapsedMs)
        : detailedHuman,
    );
    if (
      interrupted ||
      passed !== rows.length ||
      cleanupErrors.length
    ) {
      process.exitCode = 1;
    }
  });

  const optimizeCommand = cli.command("optimize")
      .description("Optimize prompt instructions and write standard element YAML")
      .addOption(
        new Option(
          "--inputs <pattern>",
          "Repeatable JSONL file/glob with disjoint Train, Validation, and Test input IDs",
        ).argParser(collect).default([]),
      )
      .addOption(
        new Option(
          "--ground-truth <pattern>",
          "Repeatable reviewed ground-truth JSON keyed by input ID and element ID",
        ).argParser(collect).default([]),
      )
      .addOption(
        new Option(
          "--element <id>",
          "Prompt element ID (repeatable; omitted selects every prompt element)",
        ).argParser(collect).default([]),
      )
      .option("--output-dir <path>", "Write optimized YAML and manifests to a new candidate directory")
      .option("--in-place", "Atomically replace writable local referenced element YAML")
      .addOption(
        new Option(
          "--from-candidate <path>",
          "Publish an exact selected optimized YAML with --in-place (repeatable)",
        ).argParser(collect).default([]),
      )
      .option("--max-metric-calls <n>", "Maximum Ax metric calls for bounded search", "48")
      .requiredOption("--taxonomy <path>", "Taxonomy YAML manifest")
      .addOption(new Option("--plugin <specifier>", "Trusted compiled JS plugin path or installed package").argParser(collect).default([]))
      .option("--model <id>", "Copilot model (pinned for comparisons)", "gpt-5.6-sol-fast")
      .option("--json", "Emit complete machine-readable JSON");
  configureTaxonomeHelp(optimizeCommand, style);
  optimizeCommand.action(async (options: OptimizeOptions) => {
    if (options.fromCandidate.length) {
      if (!options.inPlace || options.outputDir) {
        throw new Error(
          "--from-candidate requires --in-place and cannot use --output-dir",
        );
      }
      if (
        options.inputs.length ||
        options.groundTruth.length ||
        options.element.length
      ) {
        throw new Error(
          "--from-candidate derives elements from selected YAML; omit --inputs, --ground-truth, and --element",
        );
      }
      const taxonomy = await loadExecutionTaxonomy({
        ...options,
        elementOverride: [],
      });
      const promoted = await loadExecutionTaxonomy({
        ...options,
        elementOverride: options.fromCandidate,
      });
      const overrides = await prepareElementOverrides(options.fromCandidate);
      const {
        optimizationManifestSchema,
        promptContractHash,
        semanticHash,
      } = await import("taxonomy-engine/optimization-v2");
      const results = [];
      for (const [elementId, rawElement] of overrides.values) {
        const source = taxonomy.elementById.get(elementId);
        const candidate = promoted.elementById.get(elementId);
        if (
          !source ||
          !candidate ||
          source.implementation.type !== "prompt" ||
          candidate.implementation.type !== "prompt"
        ) {
          throw new Error(
            `--from-candidate requires an existing prompt element: ${elementId}`,
          );
        }
        let candidatePath: string | undefined;
        for (const path of options.fromCandidate) {
          const value = parseYaml(await readFile(path, "utf8")) as unknown;
          if (semanticHash(value) === overrides.hashes[elementId]) {
            candidatePath = path;
            break;
          }
        }
        if (!candidatePath) {
          throw new Error(`Cannot resolve candidate path for '${elementId}'`);
        }
        const manifestPath = join(
          dirname(resolve(candidatePath)),
          `${elementId}.optimization.manifest.json`,
        );
        const manifest = optimizationManifestSchema.parse(
          JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
        );
        if (
          manifest.element_id !== elementId ||
          manifest.taxonomy.id !== taxonomy.id ||
          manifest.taxonomy.version !== taxonomy.version ||
          manifest.taxonomy.digest !== taxonomy.digest ||
          manifest.contract_hash !== promptContractHash(taxonomy, source) ||
          manifest.optimized_element_sha256 !== semanticHash(rawElement)
        ) {
          throw new Error(
            `Candidate provenance does not match '${elementId}' and the loaded taxonomy`,
          );
        }
        results.push({
          elementId,
          element: {
            implementation: { prompt: candidate.implementation.prompt },
          },
          manifest,
        });
      }
      const paths = await writeInPlaceSet({
        taxonomyPath: options.taxonomy,
        results,
      });
      const output = {
        taxonomy: {
          id: taxonomy.id,
          version: taxonomy.version,
          digest: taxonomy.digest,
        },
        optimized: results.map(result => {
          const path = paths.find(candidate =>
            candidate.elementId === result.elementId
          )!;
          return {
            element_id: result.elementId,
            yaml: displayPath(path.yaml),
            manifest: displayPath(path.manifest),
            train_ids: result.manifest.train_ids,
            validation_ids: result.manifest.validation_ids,
            settings: result.manifest.settings,
            metrics: result.manifest.metrics,
          };
        }),
        skipped: [],
      };
      emitCommandOutput(
        options.json,
        output,
        renderOptimizeHuman(output.optimized.map(result => ({
          ...result,
          yaml_path: result.yaml,
          manifest_path: result.manifest,
        }))),
      );
      return;
    }
    if (Boolean(options.outputDir) === Boolean(options.inPlace)) {
      throw new Error("Choose exactly one of --output-dir or --in-place");
    }
    const taxonomy = await loadExecutionTaxonomy({
      ...options,
      elementOverride: [],
    });
    const data = await loadEvaluationData(
      options.inputs,
      options.groundTruth,
      taxonomy,
    );
    const maxMetricCalls = Number(options.maxMetricCalls);
    if (
      !Number.isInteger(maxMetricCalls) ||
      maxMetricCalls < 1 ||
      maxMetricCalls > 100
    ) {
      throw new Error("--max-metric-calls must be 1..100");
    }

    const explicit = options.element;
    const duplicateIds = explicit.filter(
      (id, index) => explicit.indexOf(id) !== index,
    );
    const unknownIds = explicit.filter(id => !taxonomy.elementById.has(id));
    const deterministicIds = explicit.filter(
      id => taxonomy.elementById.get(id)?.implementation.type === "deterministic",
    );
    const validationErrors = [
      ...(duplicateIds.length
        ? [`Duplicate --element ID(s): ${[...new Set(duplicateIds)].join(", ")}`]
        : []),
      ...(unknownIds.length
        ? [`Unknown --element ID(s): ${unknownIds.join(", ")}`]
        : []),
      ...(deterministicIds.length
        ? [`Deterministic elements cannot be optimized: ${deterministicIds.join(", ")}`]
        : []),
    ];
    if (validationErrors.length) {
      throw new Error(validationErrors.join("; "));
    }
    const selected = taxonomy.elements
      .filter(element =>
        element.implementation.type === "prompt" &&
        (!explicit.length || explicit.includes(element.id))
      );
    if (!selected.length) {
      throw new Error("Taxonomy has no selected prompt-backed elements");
    }
    const preflightErrors: string[] = [];
    for (const element of selected) {
      const eligible = data.inputs.filter(input =>
        input.elements.includes(element.id)
      );
      for (const split of ["train", "validation"] as const) {
        if (!eligible.some(input => input.split === split)) {
          preflightErrors.push(
            `${element.id}: missing eligible ${split === "train" ? "Train" : "Validation"} input`,
          );
        }
      }
      for (const input of eligible.filter(input =>
        input.split === "train" || input.split === "validation"
      )) {
        if (!data.ground_truth.values[input.id]?.[element.id]) {
          preflightErrors.push(
            `${element.id}: missing ground truth for ${input.id}`,
          );
        }
      }
    }
    if (preflightErrors.length) {
      throw new Error(preflightErrors.join("; "));
    }
    const deterministic = explicit.length
      ? []
      : taxonomy.elements
        .filter(element => element.implementation.type === "deterministic")
        .map(element => element.id);
    const dashboard = new OptimizationDashboard(
      selected.map(element => element.id),
      deterministic,
      style,
      process.stderr,
      Boolean(options.json),
    );
    dashboard.start();
    for (const element of selected) {
      const eligible = data.inputs.filter(input =>
        input.elements.includes(element.id)
      );
      dashboard.update({
        elementId: element.id,
        status: "PREFLIGHT",
        train: eligible.filter(input => input.split === "train").length,
        validation: eligible.filter(input => input.split === "validation").length,
        detail: `${options.model}; bootstrap disabled`,
      });
    }

    const {
      closeTransports,
      copilotAI,
      openCopilotTransport,
    } = await import("taxonomy-engine/copilot");
    const { optimizePromptElement } =
      await import("taxonomy-engine/optimization-v2");
    const results: Array<{
      elementId: string;
      element: Awaited<ReturnType<typeof optimizePromptElement>>["element"];
      manifest: Awaited<ReturnType<typeof optimizePromptElement>>["manifest"];
    }> = [];
    let failure: unknown;
    try {
      for (const element of selected) {
        const student = await openCopilotTransport(options.model);
        let teacher: Awaited<ReturnType<typeof openCopilotTransport>> | undefined;
        try {
          teacher = await openCopilotTransport(options.model);
          const result = await optimizePromptElement(
            taxonomy,
            element.id,
            data.inputs,
            data.ground_truth.values,
            copilotAI(student, options.model),
            copilotAI(teacher, options.model, ""),
            options.model,
            maxMetricCalls,
            progress => {
              dashboard.update({
                elementId: element.id,
                status: progress.phase === "complete" ? "DONE" : "OPTIMIZING",
                metricCalls: progress.metricCalls,
                ...(progress.trial === undefined
                  ? {}
                  : { trial: progress.trial }),
                ...(progress.totalTrials === undefined
                  ? {}
                  : { totalTrials: progress.totalTrials }),
                ...(progress.candidateCount === undefined
                  ? {}
                  : { candidateCount: progress.candidateCount }),
                ...(progress.latestScore === undefined
                  ? {}
                  : { latestScore: progress.latestScore }),
                ...(progress.bestScore === undefined
                  ? {}
                  : { bestScore: progress.bestScore }),
                ...(progress.paretoFrontSize === undefined
                  ? {}
                  : { paretoFrontSize: progress.paretoFrontSize }),
                ...(progress.stopReason === undefined
                  ? {}
                  : { stopReason: progress.stopReason }),
                detail: progress.message,
              });
            },
          );
          results.push({ elementId: element.id, ...result });
        } finally {
          await closeTransports(teacher ? [student, teacher] : [student]);
        }
      }
    } catch (error) {
      failure = error;
      const active = selected.find(element =>
        !results.some(result => result.elementId === element.id)
      );
      if (active) {
        dashboard.update({
          elementId: active.id,
          status: "FAILED",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      dashboard.finalize();
    }
    if (failure) throw failure;
    const paths = options.inPlace
      ? await writeInPlaceSet({
          taxonomyPath: options.taxonomy,
          results,
        })
      : await writeCandidateSet({
          outputDir: options.outputDir!,
          results,
        });
    const output = {
      taxonomy: {
        id: taxonomy.id,
        version: taxonomy.version,
        digest: taxonomy.digest,
      },
      optimized: results.map(result => {
        const path = paths.find(candidate =>
          candidate.elementId === result.elementId
        )!;
        return {
          element_id: result.elementId,
          yaml: displayPath(path.yaml),
          manifest: displayPath(path.manifest),
          train_ids: result.manifest.train_ids,
          validation_ids: result.manifest.validation_ids,
          settings: result.manifest.settings,
          metrics: result.manifest.metrics,
        };
      }),
      skipped: explicit.length
        ? []
        : taxonomy.elements
          .filter(element => element.implementation.type === "deterministic")
          .map(element => ({
            element_id: element.id,
            reason: "deterministic element",
          })),
    };
    emitCommandOutput(
      options.json,
      output,
      renderOptimizeHuman(output.optimized.map(result => ({
        ...result,
        yaml_path: result.yaml,
        manifest_path: result.manifest,
      }))),
    );
  });

  const readoutCommand = cli.command("readout <results...>")
    .description("Build deterministic counts from result files, directories, or quoted globs")
    .requiredOption("--taxonomy <path>", "Taxonomy YAML used to validate results")
    .addOption(
      new Option(
        "--inputs <pattern>",
        "Repeatable exact ATIF file, local Scope archive, or quoted glob",
      ).argParser(collect).default([]),
    )
    .addOption(
      new Option("--plugin <specifier>", "Plugin needed by taxonomy verification")
        .argParser(collect)
        .default([]),
    )
    .option("--markdown <path>", "Write Markdown preview (stdout remains JSON)");
  configureTaxonomeHelp(readoutCommand, style);
  readoutCommand.action(async (paths: string[], options: ReadoutOptions) => {
    const taxonomy = await loadExecutionTaxonomy({
      taxonomy: options.taxonomy,
      plugin: options.plugin,
      elementOverride: [],
    });
    const inputs = await loadReadoutInputs(options.inputs, taxonomy);
    const report = buildReadoutV2(
      await loadReadoutCollection(paths),
      taxonomy,
      inputs,
    );
    if (options.markdown) {
      await writeFile(options.markdown, readoutMarkdownV2(report));
    }
    emitJson(report);
    if (report.failed_runs.length) process.exitCode = 1;
  });

  return cli;
}
