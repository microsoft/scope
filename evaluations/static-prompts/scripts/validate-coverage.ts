#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { listTargets } from "../adapter/registry.js";

interface EvaluationManifest {
  qualityFamilies: Array<{ id: string; variants: string[] }>;
}

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

function assertSame(label: string, expected: string[], actual: string[]): void {
  const expectedValue = JSON.stringify(sorted(expected));
  const actualValue = JSON.stringify(sorted(actual));
  if (expectedValue !== actualValue) {
    throw new Error(
      `${label} coverage mismatch; expected=${expectedValue}, actual=${actualValue}`,
    );
  }
}

export async function validateCoverage(
  packageRoot = PACKAGE_ROOT,
): Promise<{
  qualityTargets: number;
}> {
  const manifest = YAML.parse(
    await readFile(resolve(packageRoot, "evaluation-manifest.yaml"), "utf8"),
  ) as EvaluationManifest;

  const manifestQuality = manifest.qualityFamilies.flatMap((family) =>
    family.variants.map((variant) => `${family.id}/${variant}`),
  );
  const adapterQuality = listTargets().map((target) => target.adapterId);
  assertSame("quality adapter", manifestQuality, adapterQuality);

  return {
    qualityTargets: adapterQuality.length,
  };
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  validateCoverage()
    .then(({ qualityTargets }) => {
      console.log(
        `Validated ${qualityTargets} quality targets`,
      );
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
