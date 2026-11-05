// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

interface ComposeService {
  build?: {
    args?: Record<string, string>;
  };
  cpus?: number;
  depends_on?: Record<string, { condition: string }>;
  healthcheck?: {
    test?: string[];
    start_period?: string;
  };
  mem_limit?: string;
  volumes?: Array<{
    source?: string;
    target: string;
  }>;
}

interface ComposeConfig {
  services: Record<string, ComposeService>;
}

// Keep the default unit suite runnable without Docker while preserving strict
// merged-configuration validation whenever Compose is available.
const dockerComposeAvailable =
  spawnSync("docker", ["compose", "version"], {
    encoding: "utf8",
  }).status === 0;

describe("development Docker Compose configuration", () => {
  it.skipIf(!dockerComposeAvailable)(
    "keeps the gateway cold-build resources and Copilot worker dependency",
    () => {
      const result = spawnSync(
        "docker",
        [
          "compose",
          "-f",
          "docker-compose.yml",
          "-f",
          "docker-compose.dev.yml",
          "--profile",
          "copilot",
          "config",
          "--format",
          "json",
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? "",
            NPM_CONFIG_REGISTRY: "https://packages.example.test/npm/",
            COREPACK_NPM_REGISTRY: "https://corepack.example.test/",
          },
        },
      );

      expect(result.status, result.stderr).toBe(0);

      const config = JSON.parse(result.stdout) as ComposeConfig;
      const api = config.services.api;
      const gateway = config.services.gateway;
      const copilotWorker = config.services["coder-acp-copilot"];

      expect(api.build?.args).toMatchObject({
        NPM_CONFIG_REGISTRY: "https://packages.example.test/npm/",
        COREPACK_NPM_REGISTRY: "https://corepack.example.test/",
      });
      expect(copilotWorker.build?.args).toMatchObject({
        NPM_CONFIG_REGISTRY: "https://packages.example.test/npm/",
        COREPACK_NPM_REGISTRY: "https://corepack.example.test/",
      });
      expect(gateway.cpus).toBeUndefined();
      expect(gateway.mem_limit).toBe(String(2 * 1024 ** 3));
      expect(gateway.healthcheck?.start_period).toBe("10m0s");
      expect(gateway.healthcheck?.test).toEqual([
        "CMD-SHELL",
        "wget -qO- http://127.0.0.1:18000/health || exit 1",
      ]);
      expect(gateway.volumes).toContainEqual(
        expect.objectContaining({
          source: "gateway_target",
          target: "/build/target",
        }),
      );
      expect(copilotWorker.depends_on?.gateway?.condition).toBe(
        "service_healthy",
      );
    },
  );
});
