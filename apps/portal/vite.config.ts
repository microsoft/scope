// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { spawnSync } from "node:child_process";
import path from "path";
import { resolvePortalBuildMetadata } from "./src/lib/build-metadata";

/** Read one Git value without a shell or error-shaped stderr output. */
function readGitValue(arguments_: string[]): string | undefined {
  const result = spawnSync("git", arguments_, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0) {
    return undefined;
  }

  return result.stdout.trim();
}

const buildMetadata = resolvePortalBuildMetadata({
  PORTAL_GIT_INFO_ENABLED: process.env.PORTAL_GIT_INFO_ENABLED,
  GIT_COMMIT: process.env.GIT_COMMIT,
  GIT_BRANCH: process.env.GIT_BRANCH,
  BUILD_TIME: process.env.BUILD_TIME,
}, {
  readCommit: () => readGitValue(["rev-parse", "HEAD"]),
  readBranch: () => readGitValue(["rev-parse", "--abbrev-ref", "HEAD"]),
});

export default defineConfig({
  plugins: [react()],
  define: {
    __GIT_COMMIT__: JSON.stringify(buildMetadata.commit),
    __BUILD_TIME__: JSON.stringify(buildMetadata.buildTime),
    __GIT_BRANCH__: JSON.stringify(buildMetadata.branch),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5100,
    proxy: {
      "/api": {
        target: process.env.VITE_API_PROXY_TARGET || "http://localhost:3100",
        changeOrigin: true,
      },
      "/openapi.json": {
        target: process.env.VITE_API_PROXY_TARGET || "http://localhost:3100",
        changeOrigin: true,
      },
      "/api-docs": {
        target: process.env.VITE_API_PROXY_TARGET || "http://localhost:3100",
        changeOrigin: true,
      },
      "/health": {
        target: process.env.VITE_API_PROXY_TARGET || "http://localhost:3100",
        changeOrigin: true,
      },
      "/ready": {
        target: process.env.VITE_API_PROXY_TARGET || "http://localhost:3100",
        changeOrigin: true,
      },
      "/about": {
        target: process.env.VITE_API_PROXY_TARGET || "http://localhost:3100",
        changeOrigin: true,
      },
    },
  },
});
