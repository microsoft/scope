// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export class AdapterValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterValidationError";
  }
}

export function record(value: unknown, label = "input"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AdapterValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function requiredString(
  value: unknown,
  label: string,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AdapterValidationError(`${label} must be a non-empty string`);
  }
  return value;
}

export function optionalString(
  value: unknown,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}

export function optionalBoolean(
  value: unknown,
  label: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new AdapterValidationError(`${label} must be a boolean`);
  }
  return value;
}

export function optionalPositiveInteger(
  value: unknown,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new AdapterValidationError(`${label} must be a positive integer`);
  }
  return value as number;
}

export function stringArray(
  value: unknown,
  label: string,
  optional = true,
): string[] {
  if (value === undefined && optional) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new AdapterValidationError(`${label} must be an array of strings`);
  }
  return value;
}

export function objectArray(
  value: unknown,
  label: string,
  optional = true,
): Record<string, unknown>[] {
  if (value === undefined && optional) return [];
  if (!Array.isArray(value)) {
    throw new AdapterValidationError(`${label} must be an array`);
  }
  return value.map((item, index) => record(item, `${label}[${index}]`));
}
