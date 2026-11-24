// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

interface Probe {
  exec?: { command: string[] };
  timeoutSeconds: number;
  periodSeconds: number;
  failureThreshold: number;
}

interface Container {
  name: string;
  image: string;
  command?: string[];
  args?: string[];
  restartPolicy?: string;
  env?: { name: string; value: string }[];
  volumeMounts?: { name: string; mountPath: string }[];
  startupProbe?: Probe;
  readinessProbe?: Probe;
}

interface PodSpec {
  serviceAccountName: string;
  initContainers?: Container[];
  containers: Container[];
  volumes?: { name: string; emptyDir?: object; csi?: object }[];
}

interface Manifest {
  kind: string;
  metadata: { name: string; namespace: string };
  spec?: { template?: { spec: PodSpec } };
}

const { parseAllDocuments }: {
  parseAllDocuments: (source: string) => { toJSON: () => Manifest }[];
} = createRequire(resolve("packages/shared/package.json"))("yaml");

const helmVersion = spawnSync("helm", ["version", "--short"], { encoding: "utf8" });
const helmMissing = Boolean(
  helmVersion.error && "code" in helmVersion.error && helmVersion.error.code === "ENOENT",
);
if (!helmMissing && helmVersion.status !== 0) {
  throw helmVersion.error ?? new Error(helmVersion.stderr);
}

function render(...overrides: string[]): Manifest[] {
  const result = spawnSync("helm", [
    "template", "scope", "deploy/helm/scope", "--namespace", "scope-benchmarks",
    "--set", "global.namespace=scope-benchmarks",
    "--set", "global.imageTag=app-revision",
    "--set", "azure.workloadIdentityClientId=test-backend",
    "--set", "azure.workerWorkloadIdentityClientId=test-worker",
    "--set", "azure.keyVaultName=test-vault",
    "--set", "azure.keyVaultUri=https://test-vault.vault.azure.net/",
    "--set", "azure.redisHostName=redis.example.test",
    "--set", "azure.tenantId=test-tenant",
    "--set", "workers.coderAcpCopilot.enabled=true",
    "--set", "workers.coderAcpClaudeCode.enabled=true",
    ...overrides,
  ], { encoding: "utf8" });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return parseAllDocuments(result.stdout).map((document) => document.toJSON());
}

function pod(manifests: Manifest[], component: string): PodSpec {
  const spec = manifests.find((manifest) =>
    manifest.kind === "Deployment" && manifest.metadata.name === `scope-${component}`,
  )?.spec?.template?.spec;
  if (!spec) throw new Error(`Missing Deployment for ${component}`);
  return spec;
}

describe.skipIf(helmMissing)("Scope Helm worker sidecars (requires helm on PATH)", () => {
  let manifests: Manifest[];
  beforeAll(() => { manifests = render(); });

  it("keeps all resources in the custom namespace without changing application image tags", () => {
    expect(manifests.every((manifest) => manifest.metadata.namespace === "scope-benchmarks")).toBe(true);
    expect(pod(manifests, "api").containers[0].image).toBe("ghcr.io/microsoft/scope-api:app-revision");
  });

  for (const [component, key] of [
    ["coder-acp-copilot", "coderAcpCopilot"],
    ["coder-acp-claude-code", "coderAcpClaudeCode"],
  ]) {
    it(`${component} binds the digest-pinned stdio gateway only to pod loopback`, () => {
      const spec = pod(manifests, component);
      const gateway = spec.initContainers?.find((container) => container.name === "mcp-gateway");
      expect(gateway?.image).toMatch(/^ghcr\.io\/mcpjungle\/mcpjungle@sha256:[a-f0-9]{64}$/);
      expect(gateway?.command).toEqual(["/mcpjungle"]);
      expect(gateway?.args).toEqual(["start", "--host", "127.0.0.1", "--port", "8080"]);
      expect(spec.containers[0].env).toContainEqual({
        name: "MCP_GATEWAY_URL", value: "http://127.0.0.1:8080",
      });
      expect(spec.serviceAccountName).toBe("scope-worker-workload-identity");
      expect(spec.volumes).toEqual([{ name: "workspace", emptyDir: {} }]);
      for (const container of [gateway, spec.containers[0]]) {
        expect(container?.volumeMounts).toEqual([{ name: "workspace", mountPath: "/workspace" }]);
      }
    });

    it(`${component} gates native-sidecar startup on an in-container loopback health probe`, () => {
      const gateway = pod(manifests, component).initContainers?.[0];
      expect(gateway?.restartPolicy).toBe("Always");
      expect(gateway?.startupProbe).toBeDefined();
      expect(gateway?.readinessProbe).toBeDefined();
      for (const probe of [gateway?.startupProbe, gateway?.readinessProbe]) {
        expect(probe?.exec?.command).toEqual([
          "curl", "--fail", "--silent", "--show-error", "--max-time", "2",
          "http://127.0.0.1:8080/health",
        ]);
        expect(probe).not.toHaveProperty("httpGet");
        expect(probe).not.toHaveProperty("tcpSocket");
        expect(probe?.timeoutSeconds).toBeGreaterThan(2);
        expect(probe?.periodSeconds).toBeGreaterThan(0);
        expect(probe?.failureThreshold).toBeGreaterThan(1);
      }
    });

    it(`${component} still supports disabling the MCP sidecar`, () => {
      const spec = pod(render("--set", `workers.${key}.mcpGateway.enabled=false`), component);
      expect(spec.initContainers).toBeUndefined();
      expect(spec.containers[0].env?.some((entry) => entry.name === "MCP_GATEWAY_URL")).toBe(false);
    });
  }
});
