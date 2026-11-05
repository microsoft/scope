// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { HandlerRegistry } from "./handlers.js";
import {
  loadTaxonomy,
  serializableTaxonomy,
  taxonomyDigest,
} from "./taxonomy.js";

const directories: string[] = [];

/** Creates one owned temporary taxonomy project. */
async function tempProject(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "taxonome-taxonomy-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true })
  ));
});

const timeoutElement = `
id: beh-timeout
label: Timeout
category_id: invocation
implementation:
  type: deterministic
  handler: acme/test-v1
  config:
    threshold_ms: 2500
preconditions:
  requires_complete_trajectory: false
output:
  evidence_roles:
    call:
      type: atif.tool_call
      max: 1
      description: Timed-out call.
`;

/** Creates a neutral deterministic registry for loader normalization tests. */
function testHandlers(): HandlerRegistry {
  const registry = new HandlerRegistry();
  registry.register({
    "acme/test-v1": {
      configSchema: z.object({
        threshold_ms: z.number().positive().optional(),
      }).strict(),
      evaluate: () => ({ state: "completed", observed: false }),
    },
  }, {
    name: "taxonomy-engine-test",
    origin: "local",
  });
  return registry;
}

describe("scope/taxonomy/v1 loader", () => {
  it("normalizes embedded and referenced elements to the same canonical digest", async () => {
    const root = await tempProject();
    await mkdir(join(root, "elements"));
    await writeFile(join(root, "elements", "timeout.yaml"), timeoutElement);
    await writeFile(join(root, "referenced.yaml"), `
schema_version: scope/taxonomy/v1
id: behavior
version: 1.0.0
surfaces:
  - id: surface-mcp
    label: MCP
elements:
  - path: elements/timeout.yaml
`);
    await writeFile(join(root, "embedded.yaml"), `
version: 1.0.0
id: behavior
schema_version: scope/taxonomy/v1
elements:
  - ${timeoutElement.trim().replaceAll("\n", "\n    ")}
surfaces:
  - label: MCP
    id: surface-mcp
`);

    const handlers = testHandlers();
    const referenced = await loadTaxonomy(join(root, "referenced.yaml"), { handlers });
    const embedded = await loadTaxonomy(join(root, "embedded.yaml"), {
      handlers: testHandlers(),
    });

    expect(referenced.digest).toBe(embedded.digest);
    expect(serializableTaxonomy(referenced)).toEqual(serializableTaxonomy(embedded));
    expect(referenced.elementById.get("beh-timeout")).toMatchObject({
      implementation: {
        type: "deterministic",
        handler: "acme/test-v1",
        config: { threshold_ms: 2500 },
      },
      preconditions: {
        requires_recorded_discovery: false,
        requires_complete_trajectory: false,
        requires_task: false,
      },
    });
  });

  it("normalizes omitted preconditions and includes changed values in the digest", async () => {
    const root = await tempProject();
    const manifest = (preconditions: string) => `
schema_version: scope/taxonomy/v1
id: preconditions
version: 1.0.0
surfaces: []
elements:
  - id: prompt
    label: Prompt
    implementation:
      type: prompt
      prompt: Test.
${preconditions}
    output:
      evidence_roles:
        step:
          type: atif.step
          min: 0
          description: Optional step.
`;
    await writeFile(join(root, "omitted.yaml"), manifest(""));
    await writeFile(join(root, "explicit.yaml"), manifest(`
    preconditions:
      requires_recorded_discovery: false
      requires_complete_trajectory: false
      requires_task: false
`));
    await writeFile(join(root, "changed.yaml"), manifest(`
    preconditions:
      requires_recorded_discovery: false
      requires_complete_trajectory: false
      requires_task: true
`));
    const omitted = await loadTaxonomy(join(root, "omitted.yaml"), {
      handlers: testHandlers(),
    });
    const explicit = await loadTaxonomy(join(root, "explicit.yaml"), {
      handlers: testHandlers(),
    });
    const changed = await loadTaxonomy(join(root, "changed.yaml"), {
      handlers: testHandlers(),
    });
    expect(omitted.elementById.get("prompt")?.preconditions).toEqual({
      requires_recorded_discovery: false,
      requires_complete_trajectory: false,
      requires_task: false,
    });
    expect(omitted.digest).toBe(explicit.digest);
    expect(changed.digest).not.toBe(omitted.digest);
  });

  it("rejects traversal, symlink escape, aliases, duplicates, unknown handlers, and invalid schemas", async () => {
    const root = await tempProject();
    const outside = await tempProject();
    await writeFile(join(outside, "outside.yaml"), timeoutElement);
    await symlink(join(outside, "outside.yaml"), join(root, "linked.yaml"));

    const manifest = (elements: string) => `
schema_version: scope/taxonomy/v1
id: behavior
version: 1.0.0
surfaces:
  - id: surface-mcp
    label: MCP
elements:
${elements}
`;

    await writeFile(join(root, "traversal.yaml"), manifest("  - path: ../outside.yaml"));
    await expect(loadTaxonomy(join(root, "traversal.yaml"), {
      handlers: testHandlers(),
    })).rejects.toThrow("Unsafe taxonomy element path");

    await writeFile(join(root, "symlink.yaml"), manifest("  - path: linked.yaml"));
    await expect(loadTaxonomy(join(root, "symlink.yaml"), {
      handlers: testHandlers(),
    })).rejects.toThrow("cannot be a symlink");

    await writeFile(join(root, "alias.yaml"), `
schema_version: scope/taxonomy/v1
id: behavior
version: 1.0.0
surfaces: &surfaces
  - id: surface-mcp
    label: MCP
elements: *surfaces
`);
    await expect(loadTaxonomy(join(root, "alias.yaml"), {
      handlers: testHandlers(),
    })).rejects.toThrow(/anchors|aliases/);

    await writeFile(join(root, "duplicate.yaml"), manifest(
      `  - ${timeoutElement.trim().replaceAll("\n", "\n    ")}\n  - ${timeoutElement.trim().replaceAll("\n", "\n    ")}`,
    ));
    await expect(loadTaxonomy(join(root, "duplicate.yaml"), {
      handlers: testHandlers(),
    })).rejects.toThrow("Duplicate taxonomy element ID");

    await writeFile(join(root, "unknown.yaml"), manifest(`
  - id: custom
    label: Custom
    implementation:
      type: deterministic
      handler: acme/missing-v1
    output:
      evidence_roles:
        step:
          type: atif.step
          description: Step.
`));
    await expect(loadTaxonomy(join(root, "unknown.yaml"), {
      handlers: testHandlers(),
    })).rejects.toThrow("Unknown deterministic handler");

    await writeFile(join(root, "schema.yaml"), manifest(`
  - id: custom
    label: Custom
    implementation:
      type: prompt
      prompt: Test.
    output_schema:
      type: object
`));
    await expect(loadTaxonomy(join(root, "schema.yaml"), {
      handlers: testHandlers(),
    })).rejects.toThrow("output.evidence_roles");

    await writeFile(join(root, "stale-evidence.yaml"), manifest(`
  - id: custom
    label: Custom
    implementation:
      type: prompt
      prompt: Test.
    evidence:
      requires_task: true
    output:
      evidence_roles:
        step:
          type: atif.step
          description: Step.
`));
    await expect(loadTaxonomy(join(root, "stale-evidence.yaml"), {
      handlers: testHandlers(),
    })).rejects.toThrow("author preconditions instead");

    await writeFile(join(root, "stale-precondition-names.yaml"), manifest(`
  - id: custom
    label: Custom
    implementation:
      type: prompt
      prompt: Test.
    preconditions:
      complete_for_negative: true
      requires_discovery_event: true
    output:
      evidence_roles:
        step:
          type: atif.step
          description: Step.
`));
    await expect(loadTaxonomy(join(root, "stale-precondition-names.yaml"), {
      handlers: testHandlers(),
    })).rejects.toThrow("requires_complete_trajectory");

    await writeFile(join(root, "stale-discovery-name.yaml"), manifest(`
  - id: custom
    label: Custom
    implementation:
      type: prompt
      prompt: Test.
    preconditions:
      requires_discovery_event: true
    output:
      evidence_roles:
        step:
          type: atif.step
          description: Step.
`));
    await expect(loadTaxonomy(join(root, "stale-discovery-name.yaml"), {
      handlers: testHandlers(),
    })).rejects.toThrow("requires_recorded_discovery");
  });

  it("canonical digest ignores object key order but includes semantic fields", () => {
    expect(taxonomyDigest({ b: 2, a: { d: 4, c: 3 } }))
      .toBe(taxonomyDigest({ a: { c: 3, d: 4 }, b: 2 }));
    expect(taxonomyDigest({ prompt: "A" })).not.toBe(taxonomyDigest({ prompt: "B" }));
  });
});
