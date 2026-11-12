// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isAlias, parseDocument, visit } from "yaml";
import { z } from "zod";
import {
  evidenceConstraintSchema,
  evidenceRoleSchema,
  type EvidenceContract,
} from "./assessment.js";
import { canonicalJsonSha256 } from "./canonical-json.js";
import { parseDefiniteJsonPath } from "./evidence.js";
import type { DeterministicHandler, HandlerProvider, HandlerRegistry } from "./handlers.js";
import {
  preconditionsSchema,
  type ElementPreconditions,
} from "./preconditions/index.js";

export const TAXONOMY_SCHEMA_VERSION = "scope/taxonomy/v1";

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i);
const semanticVersionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);

const surfaceSchema = z.object({
  id: idSchema,
  label: z.string().min(1),
  description: z.string().min(1).optional(),
}).strict();

const promptImplementationSchema = z.object({
  type: z.literal("prompt"),
  prompt: z.string().min(1),
}).strict();

const deterministicImplementationSchema = z.object({
  type: z.literal("deterministic"),
  handler: z.string().min(1),
  config: z.unknown().optional(),
}).strict();

const roleNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/);
const elementOutputSchema = z.object({
  evidence_roles: z.record(roleNameSchema, evidenceRoleSchema)
    .refine(value => Object.keys(value).length > 0, {
      message: "At least one evidence role is required",
    }),
  constraints: z.array(evidenceConstraintSchema).default([]),
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
  preconditions: preconditionsSchema,
  output: elementOutputSchema,
}).strict();

const elementReferenceSchema = z.object({
  path: z.string().min(1),
}).strict();

const taxonomyDocumentSchema = z.object({
  schema_version: z.literal(TAXONOMY_SCHEMA_VERSION),
  id: idSchema,
  version: semanticVersionSchema,
  surfaces: z.array(surfaceSchema).max(100),
  elements: z.array(z.unknown()).min(1).max(200),
}).strict();

export type TaxonomySurface = z.infer<typeof surfaceSchema>;
export type { ElementPreconditions } from "./preconditions/index.js";

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
  /** Evidence-presence preconditions evaluated before classification. */
  preconditions: ElementPreconditions;
  /** Shared evidence-role and constraint contract. */
  output: EvidenceContract;
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
  /** Complete authored element replacements keyed by exact element ID. */
  elementOverrides?: ReadonlyMap<string, unknown>;
  /** Optional safety-limit overrides used primarily by tests. */
  limits?: TaxonomyLoadLimits;
}

/** Computes a stable semantic digest independent of YAML formatting/key order. */
export function taxonomyDigest(value: unknown): string {
  return canonicalJsonSha256(value);
}

/** Rejects the obsolete draft output schema with an actionable diagnostic. */
function parseAuthoredElement(
  value: unknown,
  location: string,
): z.infer<typeof authoredElementSchema> {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "output_schema" in value
  ) {
    throw new Error(
      `Element '${location}' uses obsolete output_schema; author output.evidence_roles instead.`,
    );
  }
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "evidence" in value
  ) {
    throw new Error(
      `Element '${location}' uses obsolete element-level evidence; author preconditions instead. Occurrence evidence and output.evidence_roles are unchanged.`,
    );
  }
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "preconditions" in value
  ) {
    const preconditions = (value as Record<string, unknown>).preconditions;
    if (
      preconditions &&
      typeof preconditions === "object" &&
      !Array.isArray(preconditions)
    ) {
      const keys = preconditions as Record<string, unknown>;
      if ("complete_for_negative" in keys) {
        throw new Error(
          `Element '${location}' uses obsolete preconditions.complete_for_negative; author preconditions.requires_complete_trajectory instead.`,
        );
      }
      if ("requires_discovery_event" in keys) {
        throw new Error(
          `Element '${location}' uses obsolete preconditions.requires_discovery_event; author preconditions.requires_recorded_discovery instead.`,
        );
      }
    }
  }
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "output" in value
  ) {
    const output = (value as Record<string, unknown>).output;
    if (
      output &&
      typeof output === "object" &&
      !Array.isArray(output) &&
      "relationships" in output
    ) {
      throw new Error(
        `Element '${location}' uses obsolete output.relationships; author output.constraints instead.`,
      );
    }
    if (
      output &&
      typeof output === "object" &&
      !Array.isArray(output) &&
      Array.isArray((output as Record<string, unknown>).constraints) &&
      ((output as Record<string, unknown>).constraints as unknown[]).some(
        constraint =>
          constraint &&
          typeof constraint === "object" &&
          !Array.isArray(constraint) &&
          (constraint as Record<string, unknown>).kind === "step_after",
      )
    ) {
      throw new Error(
        `Element '${location}' uses obsolete step_after; author an after constraint with an explicit within array JSONPath.`,
      );
    }
  }
  return authoredElementSchema.parse(value);
}

/** Validates role references and the exact supported constraint contracts. */
function validateOutputContract(
  elementId: string,
  output: z.infer<typeof elementOutputSchema>,
): EvidenceContract {
  const constraints: EvidenceContract["constraints"][number][] = [];
  for (const constraint of output.constraints) {
    const role = output.evidence_roles[constraint.role];
    if (!role) {
      throw new Error(
        `Element '${elementId}' constraint references unknown role '${constraint.role}'`,
      );
    }
    if (constraint.kind === "owned_by") {
      const owner = output.evidence_roles[constraint.owner_role];
      if (!owner) {
        throw new Error(
          `Element '${elementId}' constraint references unknown owner role '${constraint.owner_role}'`,
        );
      }
      if (owner.type !== "atif.tool_call") {
        throw new Error(
          `Element '${elementId}' owned_by owner role '${constraint.owner_role}' must target atif.tool_call`,
        );
      }
      if (
        ![
          "scope.input_validation_issue",
          "atif.observation_result",
          "atif.content_part",
          "atif.image_source",
          "atif.audio_source",
        ].includes(role.type)
      ) {
        throw new Error(
          `Element '${elementId}' role '${constraint.role}' has no tool-call ownership`,
        );
      }
    } else {
      const reference = output.evidence_roles[constraint.reference_role];
      if (!reference) {
        throw new Error(
          `Element '${elementId}' constraint references unknown reference role '${constraint.reference_role}'`,
        );
      }
      if (constraint.kind === "after") {
        try {
          const within = parseDefiniteJsonPath(constraint.within).canonical;
          constraints.push({ ...constraint, within });
        } catch (error) {
          throw new Error(
            `Element '${elementId}' after constraint has invalid within JSONPath: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      } else {
        constraints.push(constraint);
      }
    }
    if (constraint.kind === "owned_by") {
      constraints.push(constraint);
    }
  }
  return {
    evidence_roles: output.evidence_roles,
    constraints,
  };
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
      preconditions: element.preconditions,
      output: element.output,
    })),
  };
}

/** Normalizes already-resolved taxonomy and element documents from a trusted store. */
export function normalizeTaxonomyDocuments(
  taxonomy: unknown,
  elementDocuments: readonly unknown[],
  options: TaxonomyLoadOptions,
): NormalizedTaxonomy {
  const document = taxonomyDocumentSchema.parse(taxonomy);
  const authoredElements = elementDocuments.map((element, index) =>
    parseAuthoredElement(element, `stored element ${index + 1}`),
  );
  if (document.elements.length !== authoredElements.length) {
    throw new Error(
      `Taxonomy declares ${document.elements.length} elements but ${authoredElements.length} were resolved`,
    );
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

    const output = validateOutputContract(authored.id, authored.output);
    if (authored.implementation.type === "prompt") {
      return { ...authored, implementation: authored.implementation, output };
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
      output,
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
    const reference = elementReferenceSchema.safeParse(entry);
    if (reference.success) {
      if (loadedReferences.size >= limits.maxReferences) {
        throw new Error(`Taxonomy exceeds maximum reference count ${limits.maxReferences}`);
      }

      const elementPath = await resolveElementPath(root, reference.data.path);
      if (loadedReferences.has(elementPath)) {
        throw new Error(`Duplicate or cyclic taxonomy element reference '${reference.data.path}'`);
      }
      loadedReferences.add(elementPath);
      authoredElements.push(
        parseAuthoredElement(
          await readYamlFile(elementPath, limits, byteState),
          reference.data.path,
        ),
      );
    } else {
      authoredElements.push(parseAuthoredElement(entry, "inline element"));
    }
  }

  if (options.elementOverrides?.size) {
    const matched = new Set<string>();
    for (let index = 0; index < authoredElements.length; index++) {
      const authored = authoredElements[index]!;
      const override = options.elementOverrides.get(authored.id);
      if (override === undefined) continue;
      const parsed = parseAuthoredElement(
        override,
        `element override '${authored.id}'`,
      );
      if (parsed.id !== authored.id) {
        throw new Error(
          `Element override ID '${parsed.id}' does not match taxonomy element '${authored.id}'`,
        );
      }
      authoredElements[index] = parsed;
      matched.add(authored.id);
    }
    const unknown = [...options.elementOverrides.keys()].filter(
      id => !matched.has(id),
    );
    if (unknown.length) {
      throw new Error(`Unknown element override ID(s): ${unknown.join(", ")}`);
    }
  }

  return normalizeTaxonomyDocuments(
    { ...document, elements: authoredElements },
    authoredElements,
    options,
  );
}
