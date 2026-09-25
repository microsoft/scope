// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ResourceParameter } from "../types/resource.js";

/**
 * Validation for resource parameter *declarations* (what a revision promises to
 * accept) and *bindings* (the values a run supplies).
 *
 * Both validate loudly. The recurring failure mode this feature guards against is
 * a run that succeeds while meaning nothing — a typo'd parameter silently ignored
 * seeds the resource with a default and produces a perfectly healthy-looking run
 * that answers a different question than the one asked.
 */

/** Shell/env identifier: letters, digits, underscore; not starting with a digit. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Reserved prefix. The runner injects `SCOPE_SETUP_ENV` into the phase
 * environment, and a parameter able to shadow it could redirect or suppress the
 * export channel the whole design depends on.
 */
const RESERVED_PREFIX = "SCOPE_";

export class ResourceParameterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceParameterError";
  }
}

/**
 * Validate a revision's parameter declarations against its exports.
 *
 * @throws ResourceParameterError listing every problem found, rather than the
 * first — a caller fixing one name at a time round-trips needlessly.
 */
export function validateParameterDeclarations(
  parameters: ResourceParameter[] | undefined,
  exports: string[] | undefined
): void {
  if (!parameters || parameters.length === 0) return;

  const problems: string[] = [];
  const exportNames = new Set(exports ?? []);
  const seen = new Set<string>();

  for (const parameter of parameters) {
    const name = parameter.name;

    if (typeof name !== "string" || name.trim() === "") {
      problems.push("a parameter is missing a name");
      continue;
    }
    if (!IDENTIFIER.test(name)) {
      problems.push(`"${name}" is not a valid environment variable name`);
    }
    if (name.startsWith(RESERVED_PREFIX)) {
      problems.push(`"${name}" uses the reserved ${RESERVED_PREFIX}* prefix`);
    }
    // Inputs and outputs sharing a name makes the publish step unreadable: the
    // value in the environment could be either the supplied input or whatever
    // setup published, depending on ordering.
    if (exportNames.has(name)) {
      problems.push(`"${name}" is declared as both a parameter and an export`);
    }
    if (seen.has(name)) {
      problems.push(`"${name}" is declared more than once`);
    }
    seen.add(name);

    if (parameter.required && parameter.default !== undefined) {
      problems.push(`"${name}" is required but also has a default, which can never apply`);
    }
  }

  if (problems.length > 0) {
    throw new ResourceParameterError(`Invalid parameter declarations: ${problems.join("; ")}`);
  }
}

export interface ResolveParamsInput {
  /** The pinned revision's declarations. */
  parameters: ResourceParameter[] | undefined;
  /** Values preset by the profile. Authoritative — a run may not change these. */
  profileParams?: Record<string, string>;
  /** Values supplied by the run. */
  runParams?: Record<string, string>;
  /** Ref used in error messages, e.g. "github-simulator@r3". */
  ref: string;
}

export interface ResolveParamsResult {
  /** Fully resolved values: defaults, overlaid by profile, overlaid by run. */
  params: Record<string, string>;
  /** Human-readable conflicts, matching the API's existing `conflicts[]` shape. */
  conflicts: string[];
  /** Problems that are not conflicts: unknown keys, missing required values. */
  errors: string[];
}

/**
 * Merge parameter values under the precedence rule the submit path already
 * enforces for `worker`, `model`, `mcpServers`, `skills` and `extensions`: the
 * profile wins.
 *
 * A run may *fill* a parameter the profile left open — that is not overriding.
 * A run may also restate a profile value identically, matching the existing
 * "omit them or match the profile values" contract. Supplying a *different*
 * value is a conflict, because two runs under the same profile that silently
 * differ are incomparable while being labelled identically, which destroys the
 * only thing a profile is for.
 */
export function resolveResourceParams(input: ResolveParamsInput): ResolveParamsResult {
  const { parameters, profileParams = {}, runParams = {}, ref } = input;
  const declared = new Map((parameters ?? []).map((p) => [p.name, p]));

  const conflicts: string[] = [];
  const errors: string[] = [];

  for (const [key, value] of Object.entries(runParams)) {
    if (!declared.has(key)) {
      errors.push(`resources.${ref}: unknown parameter "${key}"`);
      continue;
    }
    const pinned = profileParams[key];
    if (pinned !== undefined && pinned !== value) {
      conflicts.push(`resources.${ref}.${key}: sent "${value}", profile requires "${pinned}"`);
    }
  }

  for (const key of Object.keys(profileParams)) {
    if (!declared.has(key)) {
      errors.push(`resources.${ref}: profile presets unknown parameter "${key}"`);
    }
  }

  const params: Record<string, string> = {};
  for (const [name, declaration] of declared) {
    const value =
      profileParams[name] ??
      runParams[name] ??
      declaration.default;

    if (value === undefined) {
      if (declaration.required) {
        errors.push(`resources.${ref}: missing required parameter "${name}"`);
      }
      continue;
    }
    params[name] = value;
  }

  return { params, conflicts, errors };
}
