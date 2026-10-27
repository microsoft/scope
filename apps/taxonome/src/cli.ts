// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFile, writeFile } from "node:fs/promises";
import { Command, Option } from "commander";
import {
  buildReadoutV2,
  evaluate,
  loadAtifInput,
  loadPlugins,
  loadTaxonomy,
  readoutMarkdownV2,
  type Evaluation,
  type NormalizedTaxonomy,
  type PromptExecutor,
  type ScopeAtif,
} from "taxonomy-engine";
import {
  createAgentBehaviorHandlerRegistry,
} from "ax-taxonomy";
import {
  checkCaseV2,
  loadCasesV2,
  loadGoldV2,
} from "taxonomy-engine/cases-v2";
import type { CallLedger } from "taxonomy-engine/ledger";
import type { CopilotTransport } from "taxonomy-engine/copilot";
import {
  configureTaxonomeHelp,
  createTaxonomeStyle,
  type TaxonomeStyle,
} from "./style.js";

interface ExecutionOptions {
  /** Required taxonomy YAML path. */
  taxonomy: string;
  /** Explicit trusted compiled JavaScript plugin selections. */
  plugin: string[];
  /** Exact Copilot model ID; defaults to the pinned spike model. */
  model: string;
  /** External shared call-ledger path; required only when prompt execution occurs. */
  ledger?: string;
  /** Optional v2 Ax artifact path used by run/eval replay, not optimization. */
  artifact?: string;
}

interface RunOptions extends ExecutionOptions {
  /** Comma-separated element IDs; defaults to every loaded taxonomy element. */
  elements?: string;
}

interface EvalOptions extends ExecutionOptions {
  /** Path to curated v2 ATIF JSONL rows. */
  cases: string;
  /** Path to separate reviewed gold assertions. */
  gold: string;
  /** Dataset split or `all`; defaults to `heldout`. */
  split: string;
  /** Repetition count from 1 through 10, encoded by Commander as text. */
  samples: string;
  /** Optional comma-separated override for every selected case. */
  elements?: string;
}

interface OptimizeOptions extends ExecutionOptions {
  /** Path to disjoint train/validation/heldout v2 JSONL rows. */
  cases: string;
  /** Path to fixed reviewed assertions used by the metric. */
  gold: string;
  /** Prompt element ID to optimize. */
  element: string;
  /** New artifact destination; existing files are never overwritten. */
  output: string;
  /** Ax metric-evaluation cap from 1 through 100; default 48. */
  maxMetricCalls: string;
}

interface ReadoutOptions {
  /** Optional taxonomy YAML used to verify result digest. */
  taxonomy?: string;
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
  /** Reproducibility metadata and ledger snapshot. */
  metadata(): Promise<Record<string, unknown>>;
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

/** Adds required taxonomy, repeatable plugin, model, ledger, and replay options. */
function addExecutionOptions(command: Command): Command {
  return command
    .requiredOption("--taxonomy <path>", "Taxonomy YAML manifest")
    .addOption(new Option("--plugin <specifier>", "Trusted compiled JS plugin path or installed package").argParser(collect).default([]))
    .option("--model <id>", "Copilot model (pinned for comparisons)", "gpt-5.6-sol-fast")
    .option("--ledger <path>", "Shared durable all-in live-call ledger (cap 500)")
    .option("--artifact <path>", "Compatible scope/taxonome-ax/v2 replay artifact");
}

/** Loads built-ins, explicit plugins, and the authored taxonomy from invocation cwd. */
async function loadExecutionTaxonomy(
  options: Pick<ExecutionOptions, "taxonomy" | "plugin">,
): Promise<NormalizedTaxonomy> {
  // The CLI explicitly composes the shipped catalog before trusted plugins.
  const handlers = createAgentBehaviorHandlerRegistry();
  await loadPlugins(options.plugin, process.cwd(), handlers);
  return loadTaxonomy(options.taxonomy, { handlers });
}

/** Defers SDK initialization until an eligible prompt element reaches execution. */
async function createRuntime(
  options: ExecutionOptions,
  taxonomy: NormalizedTaxonomy,
  selected: readonly string[],
  purpose: string,
): Promise<LoadedExecution> {
  const promptIds = selected.filter(id =>
    taxonomy.elementById.get(id)?.implementation.type === "prompt"
  );
  if (!promptIds.length) {
    if (options.artifact) {
      throw new Error("--artifact requires at least one prompt element");
    }
    return {
      taxonomy,
      close: async () => {},
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
  let artifactHash: string | null = null;
  let starting: Promise<PromptExecutor> | undefined;

  /** Opens/verifies the shared ledger before any model submission. */
  async function openLedger(): Promise<CallLedger> {
    if (!options.ledger) {
      throw new Error("--ledger is required when selected elements use prompts");
    }
    const { CallLedger } = await import("taxonomy-engine/ledger");
    const ledger = new CallLedger(options.ledger);
    await ledger.initialize();
    return ledger;
  }

  /** Creates one SDK transport and restores an exact v2 artifact when supplied. */
  async function start(): Promise<PromptExecutor> {
    const {
      copilotAI,
      openCopilotTransport,
      taxonomyPromptExecutor,
    } = await import("taxonomy-engine/copilot");
    const { restoreOptimizationArtifactV2 } =
      await import("taxonomy-engine/optimization-v2");
    const ledger = await openLedger();
    const artifacts = new Map();
    if (options.artifact) {
      const value = JSON.parse(await readFile(options.artifact, "utf8")) as unknown;
      const elementId = typeof value === "object" && value && "element_id" in value
        ? String((value as { element_id: unknown }).element_id)
        : promptIds[0];
      const artifact = restoreOptimizationArtifactV2(
        value,
        taxonomy,
        elementId,
        options.model,
      );
      artifacts.set(elementId, artifact.optimized);
      artifactHash = artifact.contract_hash;
    }
    transport = await openCopilotTransport(ledger, options.model, purpose);
    executor = taxonomyPromptExecutor(copilotAI(transport, options.model), artifacts);
    return executor;
  }

  return {
    taxonomy,
    executor: {
      async evaluate(element, input) {
        starting ??= start();
        return (await starting).evaluate(element, input);
      },
    },
    close: async () => {
      await transport?.close();
    },
    metadata: async () => {
      const ledger = options.ledger ? await openLedger() : undefined;
      const summary = ledger ? await ledger.summary() : undefined;
      return {
        taxonomy: {
          id: taxonomy.id,
          version: taxonomy.version,
          digest: taxonomy.digest,
        },
        model: options.model,
        initialized: Boolean(transport),
        artifact_contract_hash: artifactHash,
        budget: summary
          ? { cap: summary.cap, used: summary.used, remaining: summary.remaining }
          : null,
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
  return {
    run: {
      id: run?.id ?? atif.session_id,
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
const emit = (value: unknown) =>
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

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
    cli.command("run <input>")
      .description("Evaluate taxonomy elements for ATIF JSON or a Scope .tar.gz archive")
      .option("--elements <ids>", "Comma-separated element IDs; defaults to all"),
  );
  configureTaxonomeHelp(runCommand, style);
  runCommand.action(async (location: string, options: RunOptions) => {
    const taxonomy = await loadExecutionTaxonomy(options);
    const selected = options.elements
      ? parseElementIds(options.elements)
      : taxonomy.elements.map(element => element.id);
    const atif = await loadAtifInput(location, taxonomy);
    const runtime = await createRuntime(options, taxonomy, selected, "run");
    try {
      const results = await evaluate({ atif, taxonomy }, selected, runtime.executor);
      emit({
        ...readoutRunFromAtif(atif, results),
        metadata: await runtime.metadata(),
      });
      if (results.some(result =>
        typeof result.result === "object" &&
        result.result !== null &&
        "state" in result.result &&
        (result.result as { state?: unknown }).state === "error"
      )) {
        process.exitCode = 1;
      }
    } finally {
      await runtime.close();
    }
  });

  const evalCommand = addExecutionOptions(
    cli.command("eval")
      .description("Evaluate curated ATIF cases against fixed assertions")
      .requiredOption("--cases <path>", "V2 ATIF case JSONL")
      .requiredOption("--gold <path>", "Separate expected JSON/assertions")
      .option("--split <split>", "train, validation, heldout, unit, or all", "heldout")
      .option("--samples <n>", "Repeated independent passes", "1")
      .option("--elements <ids>", "Override case element selection"),
  );
  configureTaxonomeHelp(evalCommand, style);
  evalCommand.action(async (options: EvalOptions) => {
    const taxonomy = await loadExecutionTaxonomy(options);
    const allCases = await loadCasesV2(options.cases, taxonomy);
    const gold = await loadGoldV2(options.gold);
    if (!["train", "validation", "heldout", "unit", "all"].includes(options.split)) {
      throw new Error("Invalid split");
    }
    const cases = allCases.filter(row =>
      options.split === "all" || row.split === options.split
    );
    if (!cases.length) throw new Error("No selected cases");
    const sampleCount = Number(options.samples);
    if (!Number.isInteger(sampleCount) || sampleCount < 1 || sampleCount > 10) {
      throw new Error("--samples must be 1..10");
    }
    const override = options.elements ? parseElementIds(options.elements) : undefined;
    const selectedPromptUniverse = override ??
      [...new Set(cases.flatMap(row => row.elements))];
    const runtime = await createRuntime(
      options,
      taxonomy,
      selectedPromptUniverse,
      "eval",
    );
    const before = await runtime.metadata();
    const rows: unknown[] = [];

    try {
      for (let sample = 0; sample < sampleCount; sample++) {
        for (const row of cases) {
          const selected = override ?? row.elements;
          const predictions: unknown[] = [];
          const capturingExecutor: PromptExecutor | undefined = runtime.executor
            ? {
              async evaluate(element, input) {
                const prediction = await runtime.executor!.evaluate(element, input);
                predictions.push({ element_id: element.id, prediction });
                return prediction;
              },
            }
            : undefined;
          const startedAt = Date.now();
          const results = await evaluate(
            { atif: row.atif, taxonomy },
            selected,
            capturingExecutor,
          );
          const errors = checkCaseV2(row, results, gold, selected);
          rows.push({
            case_id: row.id,
            split: row.split,
            sample,
            results,
            errors,
            latency_ms: Date.now() - startedAt,
            prompt_predictions: predictions,
          });
          process.stderr.write(
            `${style.dim(`${row.id} sample=${sample}`)} ${errors.length ? style.fail("FAIL") : style.pass("PASS")}\n`,
          );
        }
      }
      const passed = rows.filter(row =>
        !(row as { errors: unknown[] }).errors.length
      ).length;
      emit({
        passed,
        total: rows.length,
        pass_rate: passed / rows.length,
        metadata: { before, after: await runtime.metadata() },
        rows,
      });
      if (passed !== rows.length) process.exitCode = 1;
    } finally {
      await runtime.close();
    }
  });

  const optimizeCommand = addExecutionOptions(
    cli.command("optimize")
      .description("Optimize one YAML prompt element and save a v2 Ax artifact")
      .requiredOption("--cases <path>", "Disjoint v2 train/validation/heldout JSONL")
      .requiredOption("--gold <path>", "Fixed assertions")
      .requiredOption("--element <id>", "Prompt element ID")
      .requiredOption("--output <path>", "New complete artifact destination")
      .option("--max-metric-calls <n>", "Finite Ax metric budget, not all-in call cap", "48"),
  );
  configureTaxonomeHelp(optimizeCommand, style);
  optimizeCommand.action(async (options: OptimizeOptions) => {
    if (!options.ledger) throw new Error("--ledger is required for optimization");
    if (options.artifact) throw new Error("--artifact is for run/eval replay");
    const taxonomy = await loadExecutionTaxonomy(options);
    const cases = await loadCasesV2(options.cases, taxonomy);
    const gold = await loadGoldV2(options.gold);
    const maxMetricCalls = Number(options.maxMetricCalls);
    if (
      !Number.isInteger(maxMetricCalls) ||
      maxMetricCalls < 1 ||
      maxMetricCalls > 100
    ) {
      throw new Error("--max-metric-calls must be 1..100");
    }

    const { CallLedger } = await import("taxonomy-engine/ledger");
    const {
      closeTransports,
      copilotAI,
      openCopilotTransport,
    } = await import("taxonomy-engine/copilot");
    const { optimizePromptElementV2 } =
      await import("taxonomy-engine/optimization-v2");
    const ledger = new CallLedger(options.ledger);
    await ledger.initialize();
    const student = await openCopilotTransport(
      ledger,
      options.model,
      "optimize:student",
    );
    let teacher: Awaited<ReturnType<typeof openCopilotTransport>> | undefined;
    let failure: unknown;
    let output: unknown;
    try {
      teacher = await openCopilotTransport(
        ledger,
        options.model,
        "optimize:teacher",
      );
      const artifact = await optimizePromptElementV2(
        taxonomy,
        options.element,
        cases,
        gold,
        copilotAI(student, options.model),
        copilotAI(teacher, options.model, ""),
        options.model,
        maxMetricCalls,
      );
      await writeFile(
        options.output,
        `${JSON.stringify(artifact, null, 2)}\n`,
        { flag: "wx" },
      );
      output = {
        artifact: options.output,
        best_score: artifact.optimized.bestScore,
        budget: await ledger.summary(),
      };
    } catch (error) {
      failure = error;
    }
    await closeTransports(teacher ? [student, teacher] : [student], failure);
    if (!output) throw new Error("Optimizer returned no artifact");
    emit(output);
  });

  const readoutCommand = cli.command("readout <results>")
    .description("Build deterministic counts from v2 result JSON")
    .option("--taxonomy <path>", "Optional taxonomy YAML digest verification")
    .addOption(
      new Option("--plugin <specifier>", "Plugin needed by taxonomy verification")
        .argParser(collect)
        .default([]),
    )
    .option("--markdown <path>", "Write Markdown preview (stdout remains JSON)");
  configureTaxonomeHelp(readoutCommand, style);
  readoutCommand.action(async (path: string, options: ReadoutOptions) => {
    const taxonomy = options.taxonomy
      ? await loadExecutionTaxonomy({
        taxonomy: options.taxonomy,
        plugin: options.plugin,
      })
      : undefined;
    const report = buildReadoutV2(
      JSON.parse(await readFile(path, "utf8")) as unknown,
      taxonomy,
    );
    if (options.markdown) {
      await writeFile(options.markdown, readoutMarkdownV2(report));
    }
    emit(report);
  });

  return cli;
}
