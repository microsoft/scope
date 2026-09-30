// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ResourceBindingSpec, ResourceParameter } from "shared";

interface ResourceParamOverride {
  resourceRef: string;
  key: string;
  value: string;
}

function splitOnce(value: string, delimiter: string): [string, string] | null {
  const index = value.indexOf(delimiter);
  if (index < 0) return null;
  return [value.slice(0, index), value.slice(index + delimiter.length)];
}

function resourceSlug(ref: string): string {
  const match = /^(.+)@r\d+$/.exec(ref);
  return match ? match[1] : ref;
}

function parseResourceParamOverride(raw: string): ResourceParamOverride {
  const refAndRest = splitOnce(raw, ":");
  if (!refAndRest) {
    throw new Error(`Invalid --resource-param "${raw}" — expected <resource>:<KEY>=<VALUE>`);
  }
  const [resourceRef, keyValue] = refAndRest;
  const keyAndValue = splitOnce(keyValue, "=");
  if (!keyAndValue) {
    throw new Error(`Invalid --resource-param "${raw}" — expected <resource>:<KEY>=<VALUE>`);
  }
  const [key, value] = keyAndValue;
  if (!resourceRef.trim() || !key.trim()) {
    throw new Error(`Invalid --resource-param "${raw}" — resource and key are required`);
  }
  return { resourceRef: resourceRef.trim(), key: key.trim(), value };
}

export function collectRepeatable(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function parseResourceParameterDeclaration(raw: string): ResourceParameter {
  const required = raw.endsWith("!");
  const withoutBang = required ? raw.slice(0, -1) : raw;
  const defaultSplit = splitOnce(withoutBang, ":");
  const name = (defaultSplit ? defaultSplit[0] : withoutBang).trim();
  const defaultValue = defaultSplit ? defaultSplit[1] : undefined;
  if (!name) {
    throw new Error(`Invalid --param "${raw}" — parameter name is required`);
  }
  if (required && defaultValue !== undefined) {
    throw new Error(`Invalid --param "${raw}" — required parameters cannot also declare a default`);
  }
  return {
    name,
    required,
    ...(defaultValue !== undefined ? { default: defaultValue } : {}),
  };
}

export function buildResourceParameters(rawParams?: string[]): ResourceParameter[] | undefined {
  if (!rawParams || rawParams.length === 0) return undefined;
  return rawParams.map(parseResourceParameterDeclaration);
}

export function buildResourceBindingSpecs(
  resourceRefs?: string[],
  rawParamOverrides?: string[],
): ResourceBindingSpec[] | undefined {
  const specs: ResourceBindingSpec[] = (resourceRefs ?? [])
    .filter((ref) => ref.trim().length > 0)
    .map((ref) => ({ ref: ref.trim() }));

  for (const raw of rawParamOverrides ?? []) {
    const override = parseResourceParamOverride(raw);
    const matches = specs.filter(
      (spec) => spec.ref === override.resourceRef || resourceSlug(spec.ref) === override.resourceRef,
    );
    if (matches.length > 1) {
      throw new Error(`Ambiguous --resource-param "${raw}" — more than one --resources entry matches`);
    }
    const target = matches[0] ?? { ref: override.resourceRef };
    target.params = { ...(target.params ?? {}), [override.key]: override.value };
    if (!matches[0]) specs.push(target);
  }

  return specs.length > 0 ? specs : undefined;
}

export function formatParameterContract(parameters?: ResourceParameter[]): string {
  if (!parameters || parameters.length === 0) return "—";
  return parameters
    .map((parameter) => {
      const marker = parameter.required ? "!" : "";
      const fallback = parameter.default !== undefined ? `=${parameter.default}` : "";
      return `${parameter.name}${marker}${fallback}`;
    })
    .join(", ");
}

export function formatResourceBindings(resources?: ResourceBindingSpec[]): string {
  if (!resources || resources.length === 0) return "—";
  return resources
    .map((resource) => {
      const params = resource.params && Object.keys(resource.params).length > 0
        ? ` (${Object.entries(resource.params).map(([key, val]) => `${key}=${val}`).join(", ")})`
        : "";
      return `${resource.ref}${params}`;
    })
    .join(", ");
}
