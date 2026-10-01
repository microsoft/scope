// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import {
  GATES,
  isGateId,
  isPromptType,
  PROMPT_TYPES,
  type GateConfig,
  type GateId,
  type PromptType,
} from "shared/types";
import { orderGates, validateGateConfigs } from "shared/gates";

export { GATES };
export type { GateConfig, GateId, PromptType };

function readJsonOrFile(raw: string): string {
  const trimmed = raw.trim();
  const fileCandidate = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{") && existsSync(resolve(fileCandidate))) {
    return readFileSync(resolve(fileCandidate), "utf8");
  }
  if (trimmed.startsWith("@")) {
    throw new Error(`Gate config file not found: ${resolve(fileCandidate)}`);
  }
  return raw;
}

function asStringArray(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array of strings.`);
  }
  return value.map((item) => {
    if (typeof item !== "string") {
      throw new Error(`${fieldName} must be an array of strings.`);
    }
    return item.trim();
  }).filter(Boolean);
}

export function parseGateListOption(raw: string | string[] | undefined): GateId[] | undefined {
  if (raw === undefined) return undefined;
  const tokens = (Array.isArray(raw) ? raw : [raw])
    .flatMap((part) => part.split(","))
    .map((part) => part.trim())
    .filter(Boolean);

  if (tokens.length === 0 || tokens.some((token) => token.toLowerCase() === "all" || token === "*")) {
    return [];
  }

  const invalid = tokens.filter((token) => !isGateId(token));
  if (invalid.length > 0) {
    throw new Error(`Invalid gate(s): ${invalid.join(", ")}. Valid gates: ${GATES.join(", ")}.`);
  }

  return Array.from(new Set(tokens as GateId[]));
}

export function parsePromptTypeOption(raw: string | undefined): PromptType | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!isPromptType(trimmed)) {
    throw new Error(`Invalid prompt type '${raw}'. Valid types: ${PROMPT_TYPES.join(", ")}.`);
  }
  return trimmed;
}

export function formatGateList(gates: GateId[] | undefined): string {
  return !gates || gates.length === 0 ? "all" : gates.join(", ");
}

export function parseGatesOption(raw: string, defaultMaxIterations?: number): GateConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readJsonOrFile(raw));
  } catch (error) {
    throw new Error(`Invalid --gates JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("--gates must be a GateConfig[] JSON array.");
  }

  const gates = parsed.map((item, index): GateConfig => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Gate config at index ${index} must be an object.`);
    }
    const record = item as Record<string, unknown>;
    if (!isGateId(record.gate)) {
      throw new Error(`Gate config at index ${index} has invalid gate '${String(record.gate)}'. Valid gates: ${GATES.join(", ")}.`);
    }

    const criteria = asStringArray(record.criteria, `gates[${index}].criteria`) ?? [];
    if (record.promptId !== undefined && typeof record.promptId !== "string") {
      throw new Error(`gates[${index}].promptId must be a string.`);
    }
    if (record.promptText !== undefined && typeof record.promptText !== "string") {
      throw new Error(`gates[${index}].promptText must be a string.`);
    }
    const hasPromptText = typeof record.promptText === "string" && record.promptText.trim().length > 0;
    if (record.gate !== "select" && !record.promptId && !hasPromptText) {
      throw new Error(`gates[${index}].promptId or promptText is required for the ${record.gate} gate.`);
    }
    let maxIterations: number | undefined;
    if (record.maxIterations !== undefined) {
      if (typeof record.maxIterations !== "number" || !Number.isInteger(record.maxIterations) || record.maxIterations < 1) {
        throw new Error(`gates[${index}].maxIterations must be a positive integer.`);
      }
      maxIterations = record.maxIterations;
    }

    return {
      gate: record.gate,
      ...(record.promptId ? { promptId: record.promptId as string } : {}),
      ...(hasPromptText ? { promptText: (record.promptText as string).trim() } : {}),
      criteria,
      ...(maxIterations !== undefined ? { maxIterations } : {}),
    };
  });

  const validationErrors = validateGateConfigs(gates, defaultMaxIterations);
  if (validationErrors.length > 0) {
    throw new Error(validationErrors.join("\n"));
  }

  return orderGates(gates);
}
