// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  HandlerRegistry,
  TAXONOME_PLUGIN_API_VERSION,
  type DeterministicHandler,
  type TaxonomePlugin,
} from "./handlers.js";

export {
  defineTaxonomePlugin,
  TAXONOME_PLUGIN_API_VERSION,
  type DeterministicHandler,
  type HandlerConfigSchema,
  type TaxonomePlugin,
} from "./handlers.js";

/** JSON package metadata used only for plugin provenance. */
interface PackageMetadata {
  /** Package/provider name. */
  name?: string;
  /** Package/provider version. */
  version?: string;
}

/** Finds the nearest package.json above a resolved plugin entry point. */
async function findPackageMetadata(entry: string): Promise<PackageMetadata> {
  let directory = dirname(entry);
  for (;;) {
    const candidate = resolve(directory, "package.json");
    try {
      const parsed = JSON.parse(await readFile(candidate, "utf8")) as PackageMetadata;
      return parsed;
    } catch {
      const parent = dirname(directory);
      if (parent === directory) return {};
      directory = parent;
    }
  }
}

/** Narrows an imported module namespace to the versioned plugin contract. */
function parsePluginExport(module: Record<string, unknown>, specifier: string): TaxonomePlugin {
  const candidate = (module.taxonomePlugin ?? module.default) as Partial<TaxonomePlugin> | undefined;
  if (!candidate || candidate.api_version !== TAXONOME_PLUGIN_API_VERSION) {
    throw new Error(
      `Plugin '${specifier}' must export taxonomePlugin/default with api_version '${TAXONOME_PLUGIN_API_VERSION}'`,
    );
  }
  if (!candidate.provider || typeof candidate.provider.name !== "string" || !candidate.provider.name) {
    throw new Error(`Plugin '${specifier}' provider.name is required`);
  }
  if (!candidate.handlers || typeof candidate.handlers !== "object" || Array.isArray(candidate.handlers)) {
    throw new Error(`Plugin '${specifier}' handlers map is required`);
  }
  for (const [id, handler] of Object.entries(candidate.handlers)) {
    const typed = handler as Partial<DeterministicHandler>;
    if (!typed.configSchema || typeof typed.configSchema.parse !== "function" || typeof typed.evaluate !== "function") {
      throw new Error(`Plugin '${specifier}' handler '${id}' has an invalid contract`);
    }
  }
  return candidate as TaxonomePlugin;
}

/**
 * Resolves one explicit local path or installed package from the invocation cwd.
 *
 * @param specifier - Compiled JavaScript path or installed package export.
 * @param cwd - Invocation working directory, including for globally installed CLIs.
 */
async function resolvePluginEntry(
  specifier: string,
  cwd: string,
): Promise<{ entry: string; origin: "local" | "package" }> {
  const pathLike = isAbsolute(specifier) ||
    specifier.startsWith("./") ||
    specifier.startsWith("../");
  if (pathLike) {
    const entry = await realpath(resolve(cwd, specifier));
    if (!(await stat(entry)).isFile() || ![".js", ".mjs", ".cjs"].includes(extname(entry))) {
      throw new Error(`Local plugin must be a compiled JavaScript file: '${specifier}'`);
    }
    return { entry, origin: "local" };
  }

  const requireFromCwd = createRequire(resolve(cwd, "package.json"));
  return {
    entry: await realpath(requireFromCwd.resolve(specifier)),
    origin: "package",
  };
}

/**
 * Imports explicitly selected trusted plugins and registers their handlers.
 *
 * Importing executes top-level plugin code with process permissions. This is
 * not a sandbox and performs no scanning, installation, or network lookup.
 *
 * @param specifiers - Repeatable CLI/programmatic plugin selections.
 * @param cwd - Invocation cwd used for both relative and package resolution.
 * @param registry - Combined registry receiving validated plugin handlers.
 */
export async function loadPlugins(
  specifiers: readonly string[],
  cwd: string,
  registry: HandlerRegistry,
): Promise<void> {
  for (const specifier of specifiers) {
    const { entry, origin } = await resolvePluginEntry(specifier, cwd);
    const module = await import(pathToFileURL(entry).href) as Record<string, unknown>;
    const plugin = parsePluginExport(module, specifier);
    const packageMetadata = await findPackageMetadata(entry);
    const integrity = createHash("sha256").update(await readFile(entry)).digest("hex");

    registry.register(plugin.handlers, {
      name: plugin.provider.name || packageMetadata.name || specifier,
      version: plugin.provider.version ?? packageMetadata.version,
      origin,
      entry: specifier,
      integrity,
    });
  }
}
