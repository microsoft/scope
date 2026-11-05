// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  evaluate,
  HandlerRegistry,
  loadAtifInput,
  loadPlugins,
  loadTaxonomy,
} from "taxonomy-engine";

// Programmatic callers use the same registry, loader, and engine as the CLI.
const handlers = new HandlerRegistry();
await loadPlugins(["./dist/handlers/index.js"], process.cwd(), handlers);

const taxonomy = await loadTaxonomy("taxonomy.yaml", { handlers });
const atif = await loadAtifInput("inputs/run.atif.json", taxonomy);
const results = await evaluate(
  { atif, taxonomy },
  ["acme-retry-loop"],
);

process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
