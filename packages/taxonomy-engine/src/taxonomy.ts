// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isAlias, parseDocument, visit } from "yaml";
import { z } from "zod";
import type { DeterministicHandler, HandlerProvider, HandlerRegistry } from "./handlers.js";
import {
  parseTaxonomyJsonSchema,
  validateTaxonomyJson,
  type TaxonomyJsonSchema,
} from "./json-schema.js";

export const TAXONOMY_SCHEMA_VERSION = "scope/taxonomy/v1";

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i);
const semanticVersionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);

const surfaceSchema = z.object({
  id: idSchema,
  label: z.string().min(1),
  description: z.string().min(1).optional(),
}).strict();

const evidenceSchema = z.object({
  requires_discovery_event: z.boolean().default(false),
  complete_for_negative: z.boolean().default(false),
  requires_task: z.boolean().default(false),
}).strict().default({});

const promptImplementationSchema = z.object({
  type: z.literal("prompt"),
  prompt: z.string().min(1),
}).strict();

const deterministicImplementationSchema = z.object({
  type: z.literal("deterministic"),
  handler: z.string().min(1),
  config: z.unknown().optional(),
}).strict();

const authoredElementSchema = z.object({
  schema_version: z.literal(TAXONOMY_SCHEMA_VERSION).optional(),
  id: idSchema,
  label: z.string().min(1),
  description: z.string().min(1).optional(),
  category_id: idSchema.optional(),
  implementation: z.discriminatedUnion("type", [
    promptImplementationSchema,
    deterministicImplementationSchema,
  ]),
  evidence: evidenceSchema,
  output_schema: z.unknown(),
}).strict();

const elementReferenceSchema = z.object({
  path: z.string().min(1),
}).strict();

const taxonomyDocumentSchema = z.object({
  schema_version: z.literal(TAXONOMY_SCHEMA_VERSION),
  id: idSchema,
  version: semanticVersionSchema,
  surfaces: z.array(surfaceSchema).max(100),
  elements: z.array(z.union([authoredElementSchema, elementReferenceSchema])).min(1).max(200),
}).strict();

export type TaxonomySurface = z.infer<typeof surfaceSchema>;
export type ElementEvidenceRequirements = z.infer<typeof evidenceSchema>;

/** Serializable prompt implementation authored in YAML. */
export interface NormalizedPromptImplementation {
  /** Execution strategy discriminator. */
  type: "prompt";
  /** Element-specific task instruction loaded from YAML. */
  prompt: string;
}

/** Serializable deterministic implementation authored in YAML. */
export interface NormalizedDeterministicImplementation {
  /** Execution strategy discriminator. */
  type: "deterministic";
  /** Origin-independent handler ID. */
  handler: string;
  /** Validated semantic handler configuration. */
  config: unknown;
}

/** Private normalized element with compiled validator and resolved implementation. */
export interface NormalizedElement {
  /** Stable taxonomy-local element ID. */
  id: string;
  /** Reviewer-facing element label. */
  label: string;
  /** Optional longer element description. */
  description?: string;
  /** Optional static category metadata derived by reports. */
  category_id?: string;
  /** Prompt or deterministic implementation config. */
  implementation: NormalizedPromptImplementation | NormalizedDeterministicImplementation;
  /** Evidence/preflight requirements. */
  evidence: ElementEvidenceRequirements;
  /** Parsed supported JSON Schema subset. */
  output_schema: TaxonomyJsonSchema;
  /** Validates untrusted output and returns semantic diagnostics. */
  validateOutput(value: unknown): string[];
  /** Resolved handler; present only for deterministic implementations. */
  resolvedHandler?: DeterministicHandler;
  /** Provider provenance; present only for deterministic implementations. */
  handlerProvider?: HandlerProvider;
}

/** Immutable normalized taxonomy used by the engine and result envelopes. */
export interface NormalizedTaxonomy {
  /** Exact authored schema identifier. */
  schema_version: typeof TAXONOMY_SCHEMA_VERSION;
  /** Taxonomy identity. */
  id: string;
  /** Authored semantic version. */
  version: string;
  /** Canonical SHA-256 over semantic serializable content. */
  digest: string;
  /** Declared source surfaces in authored order. */
  surfaces: readonly TaxonomySurface[];
  /** Loaded elements in manifest order. */
  elements: readonly NormalizedElement[];
  /** Private exact-ID lookup. */
  elementById: ReadonlyMap<string, NormalizedElement>;
  /** Private exact-surface lookup. */
  surfaceById: ReadonlyMap<string, TaxonomySurface>;
}

/** Limits applied to YAML files and referenced-element expansion. */
export interface TaxonomyLoadLimits {
  /** Maximum bytes in one YAML file; default 1 MiB. */
  maxFileBytes?: number;
  /** Maximum aggregate YAML bytes; default 4 MiB. */
  maxTotalBytes?: number;
  /** Maximum referenced element files; default 100. */
  maxReferences?: number;
}

/** Dependencies required to resolve deterministic implementations while loading. */
export interface TaxonomyLoadOptions {
  /** Combined built-in/local/package registry. */
  handlers: HandlerRegistry;
  /** Optional safety-limit overrides used primarily by tests. */
  limits?: TaxonomyLoadLimits;
}

/** Canonically sorts object keys without changing array order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

/** Computes a stable semantic digest independent of YAML formatting/key order. */
export function taxonomyDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

/** Rejects aliases/anchors so authored YAML cannot expand unexpectedly. */
export function parseSafeYamlText(text: string, path: string): unknown {
  const document = parseDocument(text, {
    uniqueKeys: true,
    prettyErrors: true,
    strict: true,
  });
  if (document.errors.length) {
    throw new Error(`Invalid YAML '${path}': ${document.errors.map(error => error.message).join("; ")}`);
  }

  let unsupported: string | undefined;
  visit(document, (_key, node) => {
    if (isAlias(node)) {
      unsupported = "aliases";
      return visit.BREAK;
    }
    if (node && typeof node === "object" && "anchor" in node && node.anchor) {
      unsupported = "anchors";
      return visit.BREAK;
    }
    return undefined;
  });
  if (unsupported) {
    throw new Error(`YAML '${path}' cannot use ${unsupported}`);
  }
  return document.toJS({ maxAliasCount: 0 });
}

/** Reads one non-symlink YAML file while enforcing per-file and aggregate limits. */
async function readYamlFile(
  path: string,
  limits: Required<TaxonomyLoadLimits>,
  state: { totalBytes: number },
): Promise<unknown> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Taxonomy path must be a regular non-symlink file: ${path}`);
  }
  if (stat.size > limits.maxFileBytes) {
    throw new Error(`Taxonomy YAML exceeds ${limits.maxFileBytes} bytes: ${path}`);
  }
  state.totalBytes += stat.size;
  if (state.totalBytes > limits.maxTotalBytes) {
    throw new Error(`Taxonomy YAML aggregate exceeds ${limits.maxTotalBytes} bytes`);
  }
  return parseSafeYamlText(await readFile(path, "utf8"), path);
}

/** Resolves a referenced element beneath the taxonomy root without traversal/symlink escape. */
async function resolveElementPath(root: string, authoredPath: string): Promise<string> {
  if (isAbsolute(authoredPath) || authoredPath.split(/[\\/]/).includes("..")) {
    throw new Error(`Unsafe taxonomy element path '${authoredPath}'`);
  }
  const candidate = resolve(root, authoredPath);
  if ((await lstat(candidate)).isSymbolicLink()) {
    throw new Error(`Taxonomy element path cannot be a symlink: '${authoredPath}'`);
  }
  const rootReal = await realpath(root);
  const candidateReal = await realpath(candidate);
  const outside = relative(rootReal, candidateReal);
  if (outside.startsWith(`..${sep}`) || outside === ".." || isAbsolute(outside)) {
    throw new Error(`Taxonomy element path escapes taxonomy root: '${authoredPath}'`);
  }
  return candidateReal;
}

/** Returns the semantic serializable form used by digests and envelopes. */
export function serializableTaxonomy(taxonomy: Omit<NormalizedTaxonomy, "digest"> | NormalizedTaxonomy): unknown {
  return {
    schema_version: taxonomy.schema_version,
    id: taxonomy.id,
    version: taxonomy.version,
    surfaces: taxonomy.surfaces,
    elements: taxonomy.elements.map(element => ({
      id: element.id,
      label: element.label,
      ...(element.description ? { description: element.description } : {}),
      ...(element.category_id ? { category_id: element.category_id } : {}),
      implementation: element.implementation,
      evidence: element.evidence,
      output_schema: element.output_schema,
    })),
  };
}

/**
 * Loads embedded/referenced YAML forms into one immutable normalized taxonomy.
 *
 * @param path - Taxonomy manifest path.
 * @param options - Combined deterministic handler registry and optional limits.
 */
export async function loadTaxonomy(
  path: string,
  options: TaxonomyLoadOptions,
): Promise<NormalizedTaxonomy> {
  const limits: Required<TaxonomyLoadLimits> = {
    maxFileBytes: options.limits?.maxFileBytes ?? 1024 * 1024,
    maxTotalBytes: options.limits?.maxTotalBytes ?? 4 * 1024 * 1024,
    maxReferences: options.limits?.maxReferences ?? 100,
  };
  const unresolvedManifestPath = resolve(path);
  if ((await lstat(unresolvedManifestPath)).isSymbolicLink()) {
    throw new Error(`Taxonomy manifest cannot be a symlink: ${path}`);
  }
  const manifestPath = await realpath(unresolvedManifestPath);
  const root = dirname(manifestPath);
  const byteState = { totalBytes: 0 };
  const document = taxonomyDocumentSchema.parse(
    await readYamlFile(manifestPath, limits, byteState),
  );

  const authoredElements: z.infer<typeof authoredElementSchema>[] = [];
  const loadedReferences = new Set<string>();
  for (const entry of document.elements) {
    if ("path" in entry) {
      if (loadedReferences.size >= limits.maxReferences) {
        throw new Error(`Taxonomy exceeds maximum reference count ${limits.maxReferences}`);
      }
      const elementPath = await resolveElementPath(root, entry.path);
      if (loadedReferences.has(elementPath)) {
        throw new Error(`Duplicate or cyclic taxonomy element reference '${entry.path}'`);
      }
      loadedReferences.add(elementPath);
      authoredElements.push(
        authoredElementSchema.parse(await readYamlFile(elementPath, limits, byteState)),
      );
    } else {
      authoredElements.push(entry);
    }
  }

  const surfaceIds = new Set<string>();
  for (const surface of document.surfaces) {
    if (surfaceIds.has(surface.id)) {
      throw new Error(`Duplicate taxonomy surface ID '${surface.id}'`);
    }
    surfaceIds.add(surface.id);
  }

  const elementIds = new Set<string>();
  const elements: NormalizedElement[] = authoredElements.map(authored => {
    if (authored.schema_version && authored.schema_version !== document.schema_version) {
      throw new Error(`Element '${authored.id}' schema version conflicts with taxonomy`);
    }
    if (elementIds.has(authored.id)) {
      throw new Error(`Duplicate taxonomy element ID '${authored.id}'`);
    }
    elementIds.add(authored.id);

    const outputSchema = parseTaxonomyJsonSchema(authored.output_schema);
    if (authored.implementation.type === "prompt") {
      return {
        ...authored,
        implementation: authored.implementation,
        output_schema: outputSchema,
        validateOutput: (value: unknown) => validateTaxonomyJson(outputSchema, value),
      };
    }

    const registered = options.handlers.resolve(authored.implementation.handler);
    const config = registered.handler.configSchema.parse(authored.implementation.config ?? {});
    return {
      ...authored,
      implementation: {
        type: "deterministic" as const,
        handler: authored.implementation.handler,
        config,
      },
      output_schema: outputSchema,
      validateOutput: (value: unknown) => validateTaxonomyJson(outputSchema, value),
      resolvedHandler: registered.handler,
      handlerProvider: registered.provider,
    };
  });

  const withoutDigest = {
    schema_version: TAXONOMY_SCHEMA_VERSION,
    id: document.id,
    version: document.version,
    surfaces: document.surfaces,
    elements,
    elementById: new Map(elements.map(element => [element.id, element])),
    surfaceById: new Map(document.surfaces.map(surface => [surface.id, surface])),
  } satisfies Omit<NormalizedTaxonomy, "digest">;
  const normalized: NormalizedTaxonomy = {
    ...withoutDigest,
    digest: taxonomyDigest(serializableTaxonomy(withoutDigest)),
  };

  Object.freeze(normalized.surfaces);
  Object.freeze(normalized.elements);
  Object.freeze(normalized);
  return normalized;
}
