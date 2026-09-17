// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  createReadStream,
  createWriteStream,
  type WriteStream,
} from "node:fs";
import { createInterface } from "node:readline";
import { once } from "node:events";
import {
  type AdapterErrorRow,
  type AdapterInputRow,
  type AdapterOutputRow,
  type AdapterSuccessRow,
  type QualityCaseRow,
  type RedTeamCaseRow,
} from "./protocol.js";
import {
  getPromptTarget,
  isQualityFamily,
  isRedTeamSurface,
  listRedTeamTargets,
  listTargets,
} from "./registry.js";
import { composeRedTeamSurface } from "./red-team.js";
import {
  createFakeAdapterContext,
  createProductionAdapterContext,
} from "./transport.js";
import {
  AdapterValidationError,
  optionalString,
  record,
  requiredString,
} from "./validation.js";

interface RunnerOptions {
  input?: string;
  output?: string;
  samples: number;
  model?: string;
  fake: boolean;
  list: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.list) {
    process.stdout.write(
      `${JSON.stringify({
        qualityTargets: listTargets(),
        redTeamTargets: listRedTeamTargets(),
      })}\n`,
    );
    return;
  }
  const input = options.input
    ? createReadStream(options.input, "utf8")
    : process.stdin;
  const output = options.output
    ? createWriteStream(options.output, { encoding: "utf8" })
    : process.stdout;
  const context = options.fake
    ? createFakeAdapterContext(options.model)
    : createProductionAdapterContext(options.model);
  const lines = createInterface({ input, crlfDelay: Infinity });

  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      await writeRow(
        output,
        errorRow(
          `line-${lineNumber}`,
          0,
          error,
          "validation",
        ),
      );
      continue;
    }

    let row: AdapterInputRow;
    try {
      row = parseInputRow(parsed);
    } catch (error) {
      const id =
        parsed &&
        typeof parsed === "object" &&
        "id" in parsed &&
        typeof parsed.id === "string"
          ? parsed.id
          : `line-${lineNumber}`;
      await writeRow(output, errorRow(id, 0, error, "validation"));
      continue;
    }

    const repetitions = "surface" in row ? 1 : options.samples;
    for (let sampleIndex = 0; sampleIndex < repetitions; sampleIndex += 1) {
      const startedAt = performance.now();
      try {
        const result =
          "surface" in row
            ? await runRedTeamRow(row, context.model, sampleIndex, startedAt)
            : await runQualityRow(row, context, sampleIndex, startedAt);
        await writeRow(output, result);
      } catch (error) {
        await writeRow(
          output,
          errorRow(
            row.id,
            sampleIndex,
            error,
            classifyError(error),
            "family" in row ? row : undefined,
            "surface" in row ? row : undefined,
            performance.now() - startedAt,
          ),
        );
      }
    }
  }
}

async function runQualityRow(
  row: QualityCaseRow,
  context: ReturnType<typeof createProductionAdapterContext>,
  sampleIndex: number,
  startedAt: number,
): Promise<AdapterSuccessRow> {
  const variant = row.variant ?? "default";
  const input =
    row.family === "run-report" &&
    row.input &&
    typeof row.input === "object" &&
    !Array.isArray(row.input) &&
    row.expected &&
    typeof row.expected === "object" &&
    !Array.isArray(row.expected) &&
    "evidenceContext" in row.expected
      ? {
          ...row.input,
          evidenceContext: row.expected.evidenceContext,
        }
      : row.input;
  const result = await getPromptTarget(row.family, variant).run(
    input,
    variant,
    context,
  );
  return {
    caseId: row.id,
    family: row.family,
    variant,
    sampleIndex,
    status: "ok",
    latencyMs: performance.now() - startedAt,
    request: result.request,
    rawResponse: result.rawResponse,
    output: result.output,
    invocationMetadata: result.invocationMetadata,
  };
}

async function runRedTeamRow(
  row: RedTeamCaseRow,
  model: string,
  sampleIndex: number,
  startedAt: number,
): Promise<AdapterSuccessRow> {
  const result = await composeRedTeamSurface(
    row.surface,
    row.attack,
    row.input,
    model,
  );
  return {
    caseId: row.id,
    surface: row.surface,
    sampleIndex,
    status: "ok",
    latencyMs: performance.now() - startedAt,
    request: result.request,
    compositionFingerprint: result.compositionFingerprint,
    sourceRevision: result.sourceRevision,
  };
}

function parseInputRow(input: unknown): AdapterInputRow {
  const value = record(input, "row");
  const id = requiredString(value.id, "row.id");
  if (value.family !== undefined) {
    if (!isQualityFamily(value.family)) {
      throw new AdapterValidationError(
        `row.family '${String(value.family)}' is not registered`,
      );
    }
    return {
      id,
      family: value.family,
      ...(optionalString(value.variant, "row.variant")
        ? { variant: optionalString(value.variant, "row.variant") }
        : {}),
      input: value.input,
      ...("expected" in value ? { expected: value.expected } : {}),
    };
  }
  if (!isRedTeamSurface(value.surface)) {
    throw new AdapterValidationError(
      `row.surface '${String(value.surface)}' is not registered`,
    );
  }
  return {
    id,
    surface: value.surface,
    attack: requiredString(value.attack, "row.attack"),
    input: value.input,
  };
}

function errorRow(
  caseId: string,
  sampleIndex: number,
  error: unknown,
  classification: AdapterErrorRow["error"]["classification"],
  quality?: QualityCaseRow,
  redTeam?: RedTeamCaseRow,
  latencyMs = 0,
): AdapterErrorRow {
  return {
    caseId,
    ...(quality
      ? {
          family: quality.family,
          variant: quality.variant ?? "default",
        }
      : {}),
    ...(redTeam ? { surface: redTeam.surface } : {}),
    sampleIndex,
    status: "error",
    latencyMs,
    error: {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
      classification,
    },
  };
}

function classifyError(
  error: unknown,
): AdapterErrorRow["error"]["classification"] {
  if (error instanceof AdapterValidationError) return "validation";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("parse") || message.includes("json")) return "parse";
  if (
    message.includes("request failed") ||
    message.includes("empty response") ||
    message.includes("tool calls")
  ) {
    return "transport";
  }
  return "adapter";
}

async function writeRow(
  output: NodeJS.WriteStream | WriteStream,
  row: AdapterOutputRow,
): Promise<void> {
  if (!output.write(`${JSON.stringify(row)}\n`)) {
    await once(output, "drain");
  }
}

function parseArgs(args: string[]): RunnerOptions {
  const options: RunnerOptions = { samples: 1, fake: false, list: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--") continue;
    switch (arg) {
      case "--input":
        options.input = requiredString(value, "--input");
        index += 1;
        break;
      case "--output":
        options.output = requiredString(value, "--output");
        index += 1;
        break;
      case "--model":
        options.model = requiredString(value, "--model");
        index += 1;
        break;
      case "--samples": {
        const samples = Number(value);
        if (!Number.isInteger(samples) || samples < 1) {
          throw new AdapterValidationError(
            "--samples must be a positive integer",
          );
        }
        options.samples = samples;
        index += 1;
        break;
      }
      case "--fake":
        options.fake = true;
        break;
      case "--list":
        options.list = true;
        break;
      default:
        throw new AdapterValidationError(`Unknown argument '${arg}'`);
    }
  }
  return options;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
