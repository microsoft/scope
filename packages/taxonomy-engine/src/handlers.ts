// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ScopeAtif } from "./scope-atif.js";
import type { TaxonomySurface } from "./taxonomy.js";

export const TAXONOME_PLUGIN_API_VERSION = "scope/taxonome-plugin/v1";

/** Immutable taxonomy metadata exposed to third-party deterministic handlers. */
export interface DeterministicHandlerTaxonomy {
  /** Exact authored schema version. */
  schema_version: "scope/taxonomy/v1";
  /** Taxonomy ID. */
  id: string;
  /** Authored semantic version. */
  version: string;
  /** Canonical semantic digest. */
  digest: string;
  /** Declared source surfaces. */
  surfaces: readonly TaxonomySurface[];
}

/** Frozen evidence and public taxonomy metadata passed to a handler. */
export interface DeterministicHandlerInput {
  /** Normalized ATIF evidence stream. */
  atif: ScopeAtif;
  /** Public taxonomy metadata without mutable/private lookup maps. */
  taxonomy: DeterministicHandlerTaxonomy;
}

/** Parser used by a deterministic handler to validate its authored YAML config. */
export interface HandlerConfigSchema<Config> {
  /**
   * @param value - Untrusted YAML config value.
   * @returns Validated semantic configuration.
   */
  parse(value: unknown): Config;
}

/** Pure deterministic implementation resolved by an origin-independent ID. */
export interface DeterministicHandler<Config = unknown, Output = unknown> {
  /** Validates and normalizes the handler's YAML configuration. */
  configSchema: HandlerConfigSchema<Config>;
  /**
   * @param input - Frozen normalized ATIF evidence plus loaded taxonomy.
   * @param config - Validated YAML configuration.
   * @returns Typed producer output, then validated against the element's YAML schema.
   */
  evaluate(input: DeterministicHandlerInput, config: Config): Output;
}

/** Provenance of the module that registered a deterministic handler. */
export interface HandlerProvider {
  /** Human-readable provider or package name. */
  name: string;
  /** Provider/plugin version, when known. */
  version?: string;
  /** `builtin`, `local`, or `package`. */
  origin: "builtin" | "local" | "package";
  /** Resolved plugin entry point for non-built-in providers. */
  entry?: string;
  /** SHA-256 of the entry module bytes when available. */
  integrity?: string;
}

/** One resolved handler with origin-independent identity and separate provenance. */
export interface RegisteredHandler {
  /** Stable YAML-facing handler ID. */
  id: string;
  /** Trusted implementation. */
  handler: DeterministicHandler;
  /** Provider/version/origin metadata excluded from YAML semantics. */
  provider: HandlerProvider;
}

/** Versioned export contract for explicitly selected local/package plugins. */
export interface TaxonomePlugin {
  /** Exact plugin API version. */
  api_version: typeof TAXONOME_PLUGIN_API_VERSION;
  /** Provider metadata shared by exported handlers. */
  provider: {
    name: string;
    version?: string;
  };
  /** Handler map keyed by origin-independent IDs. */
  handlers: Record<string, DeterministicHandler>;
}

/** Registry shared by built-in, local-project, and installed-package handlers. */
export class HandlerRegistry {
  private readonly handlers = new Map<string, RegisteredHandler>();

  /**
   * Registers handlers without allowing order-dependent overrides.
   *
   * @param entries - Handlers to add.
   * @param provider - Origin/version/integrity metadata.
   */
  register(entries: Record<string, DeterministicHandler>, provider: HandlerProvider): void {
    for (const [id, handler] of Object.entries(entries)) {
      if (!/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(id)) {
        throw new Error(`Invalid deterministic handler ID '${id}'`);
      }
      if (provider.origin !== "builtin" && id.startsWith("scope/")) {
        throw new Error(`External plugin cannot register reserved handler ID '${id}'`);
      }
      if (this.handlers.has(id)) {
        throw new Error(`Duplicate deterministic handler ID '${id}'`);
      }
      this.handlers.set(id, { id, handler, provider: { ...provider } });
    }
  }

  /** Resolves one exact handler ID or fails before evaluation. */
  resolve(id: string): RegisteredHandler {
    const registered = this.handlers.get(id);
    if (!registered) {
      throw new Error(`Unknown deterministic handler '${id}'`);
    }
    return registered;
  }

  /** Returns JSON-safe provenance sorted by handler ID. */
  provenance(): Array<{ id: string; provider: HandlerProvider }> {
    return [...this.handlers.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(({ id, provider }) => ({ id, provider: { ...provider } }));
  }
}

/** Defines a plugin while preserving literal handler IDs for TypeScript callers. */
export function defineTaxonomePlugin<const Handlers extends Record<string, DeterministicHandler>>(
  plugin: Omit<TaxonomePlugin, "handlers"> & { handlers: Handlers },
): TaxonomePlugin {
  return plugin;
}

/** Creates an empty registry for explicit catalog/plugin composition. */
export function createHandlerRegistry(): HandlerRegistry {
  return new HandlerRegistry();
}
