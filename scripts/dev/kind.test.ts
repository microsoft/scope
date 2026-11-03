import { describe, expect, it } from "vitest";
import { renderKindStack } from "./kind.js";
import { runtimes } from "./inventory.js";
import { inspectorCommand } from "./cluster.js";

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
  it("keeps an overridden tenant and local TLS listener aligned with cluster routing", () => {
    const tenant = "22222222-2222-2222-2222-222222222222";
    const local = JSON.stringify(renderKindStack({ AUTH_TENANT_ID: tenant }));
    expect(local).toContain(`"name":"TENANT_ID","value":"${tenant}"`);
    expect(local).toContain("listen 8080 ssl");
    expect(local).toContain('"targetPort":8080');
  });
});