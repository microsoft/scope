#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createCli } from "./cli.js";
import { createTaxonomeStyle } from "./style.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Removes pnpm's literal separator before Commander parses forwarded options. */
export function normalizeCliArguments(arguments_: string[]): string[] {
  const separator = arguments_.indexOf("--", 2);
  return separator < 0
    ? [...arguments_]
    : [
      ...arguments_.slice(0, separator),
      ...arguments_.slice(separator + 1),
    ];
}

const isMain = process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const style = createTaxonomeStyle();
  const arguments_ = normalizeCliArguments(process.argv);
  const machineJson = arguments_.includes("--json");
  try {
    await createCli(style).parseAsync(arguments_);
  } catch (error) {
    // Flatten aggregate lifecycle failures into one stderr diagnostic without contaminating JSON stdout.
    const messages = error instanceof AggregateError
      ? [error.message, ...error.errors.map(cause =>
        cause instanceof Error ? cause.message : String(cause)
      )]
      : [error instanceof Error ? error.message : String(error)];

    const label = machineJson ? "taxonome:" : style.error("taxonome:");
    process.stderr.write(`${label} ${messages.join("; ")}\n`);
    process.exitCode =
      typeof error === "object" &&
        error !== null &&
        "exitCode" in error &&
        Number.isInteger((error as { exitCode?: unknown }).exitCode)
        ? Number((error as { exitCode: number }).exitCode)
        : 1;
  }
}
