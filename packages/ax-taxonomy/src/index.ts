// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  HandlerRegistry,
  loadTaxonomy,
  type NormalizedTaxonomy,
} from "taxonomy-engine";
import { timeoutHandler } from "./handlers/timeout/handler.js";

export * from "./handlers/timeout/handler.js";

/** Absolute path to the shipped agent-behavior taxonomy manifest. */
export const agentBehaviorTaxonomyPath = fileURLToPath(
  new URL("../taxonomy/taxonomy.yaml", import.meta.url),
);

/**
 * Resolves one catalog fixture beneath the package-owned fixture directory.
 *
 * @param name - Fixture filename such as `inputs.jsonl`.
 */
export function agentBehaviorFixturePath(name: string): string {
  return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
}

/** Registers reviewed agent-behavior deterministic handlers explicitly. */
export function registerAgentBehaviorHandlers(
  registry: HandlerRegistry,
): HandlerRegistry {
  registry.register(
    { "scope/timeout-v1": timeoutHandler },
    {
      name: "ax-taxonomy",
      version: "0.1.0",
      origin: "builtin",
      integrity: createHash("sha256")
        .update("scope/timeout-v1")
        .digest("hex"),
    },
  );
  return registry;
}

/** Creates a registry containing only this catalog's reviewed handlers. */
export function createAgentBehaviorHandlerRegistry(): HandlerRegistry {
  return registerAgentBehaviorHandlers(new HandlerRegistry());
}

/** Loads the shipped taxonomy with its catalog-owned deterministic handlers. */
export async function loadAgentBehaviorTaxonomy(): Promise<NormalizedTaxonomy> {
  return loadTaxonomy(agentBehaviorTaxonomyPath, {
    handlers: createAgentBehaviorHandlerRegistry(),
  });
}
