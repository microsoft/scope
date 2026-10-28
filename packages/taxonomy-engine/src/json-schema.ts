// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";

const schemaType = z.enum(["object", "array", "string", "number", "integer", "boolean", "null"]);

/**
 * Supported JSON Schema subset for taxonomy result contracts.
 *
 * The subset intentionally excludes references, executable formats, custom
 * keywords, and recursive schemas. It covers the object/array/scalar
 * constraints needed by observation results.
 */
export interface TaxonomyJsonSchema {
  /** Required JSON value kind. */
  type?: z.infer<typeof schemaType>;
  /** Exact scalar value. */
  const?: string | number | boolean | null;
  /** Allowed scalar values. */
  enum?: Array<string | number | boolean | null>;
  /** Named object-property schemas. */
  properties?: Record<string, TaxonomyJsonSchema>;
  /** Required object-property names. */
  required?: string[];
  /** Whether undeclared object properties are accepted; defaults to true. */
  additionalProperties?: boolean;
  /** Schema applied to every array item. */
  items?: TaxonomyJsonSchema;
  /** Minimum array length. */
  minItems?: number;
  /** Minimum numeric value. */
  minimum?: number;
  /** Alternative schemas; exactly one must match. */
  oneOf?: TaxonomyJsonSchema[];
}

const taxonomyJsonSchema: z.ZodType<TaxonomyJsonSchema> = z.lazy(() =>
  z.object({
    type: schemaType.optional(),
    const: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
    enum: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).min(1).optional(),
    properties: z.record(taxonomyJsonSchema).optional(),
    required: z.array(z.string().min(1)).optional(),
    additionalProperties: z.boolean().optional(),
    items: taxonomyJsonSchema.optional(),
    minItems: z.number().int().nonnegative().optional(),
    minimum: z.number().finite().optional(),
    oneOf: z.array(taxonomyJsonSchema).min(1).optional(),
  }).strict(),
);

/** Parses and bounds the authored result-schema subset. */
export function parseTaxonomyJsonSchema(value: unknown): TaxonomyJsonSchema {
  const schema = taxonomyJsonSchema.parse(value);
  const seen = new Set<TaxonomyJsonSchema>();

  /** Counts nested schema nodes and rejects excessive depth before compilation. */
  function visit(schemaNode: TaxonomyJsonSchema, depth: number): number {
    if (depth > 20) {
      throw new Error("Taxonomy output schema exceeds maximum depth 20");
    }
    if (seen.has(schemaNode)) {
      throw new Error("Taxonomy output schema cannot be recursive");
    }

    seen.add(schemaNode);
    let count = 1;
    for (const child of Object.values(schemaNode.properties ?? {})) {
      count += visit(child, depth + 1);
    }
    if (schemaNode.items) {
      count += visit(schemaNode.items, depth + 1);
    }
    for (const child of schemaNode.oneOf ?? []) {
      count += visit(child, depth + 1);
    }
    seen.delete(schemaNode);
    return count;
  }

  if (visit(schema, 0) > 500) {
    throw new Error("Taxonomy output schema exceeds maximum node count 500");
  }
  return schema;
}

/** Returns a JSON value's schema kind, distinguishing arrays, null, and integers. */
function valueType(value: unknown): z.infer<typeof schemaType> | "unknown" {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  if (["object", "string", "number", "boolean"].includes(typeof value)) {
    return typeof value as "object" | "string" | "number" | "boolean";
  }
  return "unknown";
}

/**
 * Validates a value against the supported taxonomy JSON Schema subset.
 *
 * @param schema - Parsed authored schema.
 * @param value - Detector or model output.
 * @param path - Diagnostic JSON path, default `$`.
 * @returns Human-readable validation failures.
 */
export function validateTaxonomyJson(
  schema: TaxonomyJsonSchema,
  value: unknown,
  path = "$",
): string[] {
  if (typeof value === "number" && !Number.isFinite(value)) {
    return [`${path} must be a finite JSON number`];
  }
  if (schema.oneOf) {
    const alternatives = schema.oneOf.map(candidate => validateTaxonomyJson(candidate, value, path));
    const passing = alternatives.filter(errors => errors.length === 0);
    return passing.length === 1
      ? []
      : [`${path} must match exactly one schema alternative (matched ${passing.length})`];
  }

  const errors: string[] = [];
  const actualType = valueType(value);
  if (schema.type && actualType !== schema.type && !(schema.type === "number" && actualType === "integer")) {
    return [`${path} must be ${schema.type}, got ${actualType}`];
  }
  if ("const" in schema && !Object.is(value, schema.const)) {
    errors.push(`${path} must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some(candidate => Object.is(candidate, value))) {
    errors.push(`${path} must be one of ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${path} must be >= ${schema.minimum}`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path} must contain at least ${schema.minItems} items`);
    }
    if (schema.items) {
      value.forEach((item, index) => {
        errors.push(...validateTaxonomyJson(schema.items!, item, `${path}[${index}]`));
      });
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const required of schema.required ?? []) {
      if (!(required in record)) {
        errors.push(`${path}.${required} is required`);
      }
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in record) {
        errors.push(...validateTaxonomyJson(child, record[key], `${path}.${key}`));
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(record)) {
        if (!allowed.has(key)) {
          errors.push(`${path}.${key} is not allowed`);
        }
      }
    }
  }

  return errors;
}
