// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { MONGO_REPLICA_SET_INIT, renderKindStack } from "./kind.js";
import { runtimes } from "./inventory.js";
import { findWorkload, inspectorCommand, logsArguments } from "./cluster.js";

describe("complete Kind stack", () => {
  const resources = renderKindStack({});
  const text = JSON.stringify(resources);
  it("pauses before entry without overlapping watchers or duplicate inspectors", () => {
    expect(inspectorCommand(["node", "--watch", "--inspect=9229", "--import", "tsx", "apps/api/src/index.ts"], 9230)).toEqual(["node", "--inspect-brk=0.0.0.0:9230", "--import", "tsx", "apps/api/src/index.ts"]);
    expect(() => inspectorCommand(["cargo", "run"], 9230)).toThrow(/Node entrypoint/);
  });
  it("includes a workload target and named identity for every Linux runtime", () => {
    for (const runtime of runtimes) {
      expect(resources.some((resource) => (resource.kind === "Deployment" || resource.kind === "Job") && (resource.metadata as { name: string }).name === runtime.name)).toBe(true);
      expect(resources.some((resource) => resource.kind === "ServiceAccount" && (resource.metadata as { name: string }).name === runtime.name)).toBe(true);
    }
  });
  it("does not mount an outer runtime socket, developer kubeconfig or privileged identity", () => {
    expect(text).not.toContain("docker.sock");
    expect(text).not.toContain("containerd.sock");
    expect(text).not.toContain("cluster-admin");
    expect(text).not.toContain('"privileged":true');
    for (const resource of resources.filter((resource) => resource.kind === "ServiceAccount")) expect(resource.automountServiceAccountToken).toBe(false);
  });
  it("retains persistent state and suspends utility/model Jobs", () => {
    expect(resources.filter((resource) => resource.kind === "PersistentVolume")).toHaveLength(6);
    for (const resource of resources.filter((resource) => resource.kind === "Job")) expect((resource.spec as { suspend: boolean }).suspend).toBe(true);
    const scanner = resources.find((resource) => resource.kind === "Job" && (resource.metadata as { name: string }).name === "model-scanner-copilot");
    expect((scanner?.spec as { suspend: boolean }).suspend).toBe(true);
    expect(text).toContain('"nodePort":30080');
    expect(text).toContain("--LOWKEY_IMPORT_LOCATION=/data/export.json");
    expect(text).toContain('"runAsUser":1000');
  });
  it("rolls ConfigMap consumers, and only them, when the public origin changes", () => {
    const hashes = (origin: string): Record<string, string | undefined> => Object.fromEntries(renderKindStack({ PUBLIC_ORIGIN: origin }).filter((resource) => resource.kind === "Deployment").map((resource) => [(resource.metadata as { name: string }).name, (resource.spec as { template: { metadata: { annotations?: Record<string, string> } } }).template.metadata.annotations?.["scope.dev/config-hash"]]));
    const before = hashes("https://localhost:8443");
    const after = hashes("https://scope.example.test:8443");
    for (const name of ["dev-edge", "api", "portal"]) {
      expect(before[name]).toBeDefined();
      expect(after[name]).not.toBe(before[name]);
    }
    expect(before.mongodb).toBeUndefined();
  });
  it("keeps the replica-set bootstrap valid for mongosh --eval", () => {
    expect(() => new Function(MONGO_REPLICA_SET_INIT)).not.toThrow();
    expect(MONGO_REPLICA_SET_INIT).not.toMatch(/\bawait\b/);
    expect(text).toContain(JSON.stringify(MONGO_REPLICA_SET_INIT));
  });
  it("keeps an overridden tenant and local TLS listener aligned with cluster routing", () => {
    const tenant = "22222222-2222-2222-2222-222222222222";
    const local = JSON.stringify(renderKindStack({ AUTH_TENANT_ID: tenant }));
    expect(local).toContain(`"name":"TENANT_ID","value":"${tenant}"`);
    expect(local).toContain("listen 8080 ssl");
    expect(local).toContain('"targetPort":8080');
  });
});

describe("Kind workload logs", () => {
  it("resolves apps and backing services to Deployments and one-shot steps to Jobs", () => {
    expect(findWorkload({}, "api").kind).toBe("Deployment");
    expect(findWorkload({}, "mongodb").kind).toBe("Deployment");
    expect(findWorkload({}, "dev-edge").kind).toBe("Deployment");
    expect(findWorkload({}, "db-migrate").kind).toBe("Job");
  });

  it("lists the valid workload names for an unknown name", () => {
    expect(() => findWorkload({}, "nope")).toThrow(/Unknown Kind workload nope; available: .*api.*mongodb/);
  });

  it("reads the last 100 lines of the matching workload", () => {
    expect(logsArguments("Deployment", "api")).toEqual(["logs", "deployment/api", "--tail=100"]);
    expect(logsArguments("Job", "db-migrate")).toEqual(["logs", "job/db-migrate", "--tail=100"]);
  });
});