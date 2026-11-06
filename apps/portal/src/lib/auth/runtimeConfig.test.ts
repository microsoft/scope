// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

describe.skipIf(process.platform === "win32")("Portal runtime config entrypoint", () => {
  it("serializes public auth settings and preserves escaped characters", () => {
    const directory = mkdtempSync(join(tmpdir(), "scope-portal-config-"));
    const configPath = join(directory, "config.js");
    try {
      const result = spawnSync("sh", [resolve("apps/portal/docker-entrypoint.sh")], {
        env: {
          ...process.env,
          SCOPE_CONFIG_PATH: configPath,
          SCOPE_AUTH_ENABLED: "false",
          SCOPE_DOCS_BASE_URL: "https://docs.example.com/\"quoted\"",
          SCOPE_AUTH_CLIENT_ID: "client\"\\\nnext",
          SCOPE_AUTH_AUTHORITY: "https://login.example.com/tenant",
          SCOPE_AUTH_SCOPES: "api://sample/read, api://sample/write",
        },
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);

      const window = { __SCOPE_CONFIG__: {} as Record<string, unknown> };
      runInNewContext(readFileSync(configPath, "utf8"), { window });
      expect(window.__SCOPE_CONFIG__).toEqual({
        docsBaseUrl: "https://docs.example.com/\"quoted\"",
        authEnabled: false,
        authClientId: "client\"\\\nnext",
        authAuthority: "https://login.example.com/tenant",
        authScopes: "api://sample/read, api://sample/write",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
