// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);

async function read(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}

describe("readout container configuration", () => {
  it("installs the system CA bundle in development and production stages", async () => {
    const dockerfile = await read("apps/workers/readout/Dockerfile");
    const installs = dockerfile.match(
      /apt-get install -y --no-install-recommends ca-certificates/g,
    );

    expect(installs).toHaveLength(2);
  });

  it("forwards the configured npm registry to readout image builds", async () => {
    const compose = await read("docker-compose.yml");

    for (const service of ["readout-handler", "register-handler-readout"]) {
      expect(compose).toMatch(
        new RegExp(
          `\\n  ${service}:\\n[\\s\\S]*?dockerfile: apps/workers/readout/Dockerfile\\n[\\s\\S]*?args:\\n\\s+<<: \\*npm-build-args`,
        ),
      );
    }
  });

  it("uses the development image for both post-processor registration jobs", async () => {
    const compose = await read("docker-compose.dev.yml");

    for (const service of [
      "register-handler-post-processor",
      "register-handler-taxonomy",
    ]) {
      expect(compose).toMatch(
        new RegExp(`\\n  ${service}:\\n\\s+build:\\n\\s+target: dev`),
      );
    }
  });
});
