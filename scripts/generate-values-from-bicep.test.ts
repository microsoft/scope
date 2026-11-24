// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

interface GeneratedValues {
  global: { namespace: string; imageRegistry?: string };
  azure: {
    serviceAccountName: string;
    workerWorkloadIdentityClientId?: string;
    workerServiceAccountName?: string;
  };
}

type BicepOutputs = Record<string, { value: string | number }>;

const { parse }: { parse: (source: string) => GeneratedValues } =
  createRequire(resolve("packages/shared/package.json"))("yaml");
const directories: string[] = [];
const script = resolve("scripts/generate-values-from-bicep.sh");
const workerOutputs = [
  "workerWorkloadIdentityClientId",
  "workerWorkloadIdentityServiceAccountName",
  "workerWorkloadIdentityServiceAccountNamespace",
];
const outputs: BicepOutputs = {
  keyVaultName: { value: "test-vault" },
  keyVaultUri: { value: "https://test-vault.vault.azure.net/" },
  workloadIdentityClientId: { value: "backend-client" },
  workloadIdentityServiceAccountName: { value: "backend-account" },
  workloadIdentityServiceAccountNamespace: { value: "scope-benchmarks" },
  storageAccountName: { value: "teststorage" },
  redisHostName: { value: "redis.example.test" },
  redisPort: { value: 10000 },
  workerWorkloadIdentityClientId: { value: "worker-client" },
  workerWorkloadIdentityServiceAccountName: { value: "worker-account" },
  workerWorkloadIdentityServiceAccountNamespace: { value: "scope-benchmarks" },
};

function generate(values: BicepOutputs, args: string[] = [], existingValues?: string) {
  const directory = mkdtempSync(join(tmpdir(), "scope-bicep-values-"));
  directories.push(directory);
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const outputsFile = join(directory, "outputs.json");
  const valuesFile = join(directory, "values.yaml");
  writeFileSync(outputsFile, JSON.stringify(values));
  if (existingValues !== undefined) writeFileSync(valuesFile, existingValues);
  writeFileSync(join(bin, "az"), `#!/bin/sh
set -eu
case "$*" in
  "deployment group show "*) cat "$TEST_BICEP_OUTPUTS" ;;
  "account show "*) printf 'test-tenant\\n' ;;
  *) echo "Unexpected Azure call: $*" >&2; exit 99 ;;
esac
`, { mode: 0o755 });
  const result = spawnSync("bash", [
    script, "--resource-group", "test-rg", "--deployment-name", "test-deployment",
    "--values-file", valuesFile, ...args,
  ], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, TEST_BICEP_OUTPUTS: outputsFile },
  });
  return { ...result, valuesFile };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("generate-values-from-bicep.sh namespaces", () => {
  it.each(["scope", "scope-benchmarks"])("propagates the federated namespace %s with both identities", (namespace) => {
    const result = generate({
      ...outputs,
      workloadIdentityServiceAccountNamespace: { value: namespace },
      workerWorkloadIdentityServiceAccountNamespace: { value: namespace },
    });
    expect(result.status, result.stderr).toBe(0);
    const values = parse(readFileSync(result.valuesFile, "utf8"));
    expect(values.global).toEqual({ namespace });
    expect(values.azure).toMatchObject({
      serviceAccountName: "backend-account",
      workerWorkloadIdentityClientId: "worker-client",
      workerServiceAccountName: "worker-account",
    });
  });

  it("merges an image registry override into the same global mapping", () => {
    const result = generate(outputs, ["--image-registry", "test.azurecr.io"]);
    expect(result.status, result.stderr).toBe(0);
    expect(parse(readFileSync(result.valuesFile, "utf8")).global).toEqual({
      namespace: "scope-benchmarks", imageRegistry: "test.azurecr.io",
    });
  });

  it("requires the backend namespace instead of silently using the chart default", () => {
    const withoutNamespace = { ...outputs };
    delete withoutNamespace.workloadIdentityServiceAccountNamespace;
    const result = generate(withoutNamespace);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("workloadIdentityServiceAccountNamespace");
    expect(existsSync(result.valuesFile)).toBe(false);
  });

  it("rejects differing backend/worker namespaces without overwriting an existing file", () => {
    const original = "global:\n  namespace: keep-me\n";
    const result = generate({
      ...outputs, workerWorkloadIdentityServiceAccountNamespace: { value: "other-namespace" },
    }, ["--force"], original);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("single namespace");
    expect(result.stderr).toContain("scope-benchmarks");
    expect(result.stderr).toContain("other-namespace");
    expect(readFileSync(result.valuesFile, "utf8")).toBe(original);
  });

  it.each(workerOutputs)("rejects an incomplete worker identity missing %s", (key) => {
    const incomplete = { ...outputs };
    delete incomplete[key];
    const result = generate(incomplete);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(key);
    expect(existsSync(result.valuesFile)).toBe(false);
  });

  it("still supports deployments that did not provision any worker identity", () => {
    const withoutWorker = { ...outputs };
    for (const key of workerOutputs) delete withoutWorker[key];
    const result = generate(withoutWorker);
    expect(result.status, result.stderr).toBe(0);
    const values = parse(readFileSync(result.valuesFile, "utf8"));
    expect(values.global.namespace).toBe("scope-benchmarks");
    expect(values.azure).not.toHaveProperty("workerWorkloadIdentityClientId");
    expect(values.azure).not.toHaveProperty("workerServiceAccountName");
  });
});
