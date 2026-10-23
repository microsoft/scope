#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createCli } from "./cli.js";
import { createTaxonomeStyle } from "./style.js";

const style = createTaxonomeStyle();
try {
  await createCli(style).parseAsync(process.argv);
} catch (error) {
  // Flatten aggregate lifecycle failures into one stderr diagnostic without contaminating JSON stdout.
  const messages = error instanceof AggregateError
    ? [error.message, ...error.errors.map(cause => cause instanceof Error ? cause.message : String(cause))]
    : [error instanceof Error ? error.message : String(error)];

  process.stderr.write(`${style.error("taxonome:")} ${messages.join("; ")}\n`);
  process.exitCode = 1;
}
