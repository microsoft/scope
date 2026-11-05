// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "child_process";
import path from "path";

function gitExec(cmd: string, fallback: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8" }).trim();
  } catch {
    return fallback;
  }
}

function getGitInfo() {
  const commit = process.env.GIT_COMMIT && process.env.GIT_COMMIT !== "unknown"
    ? process.env.GIT_COMMIT
    : gitExec("git rev-parse HEAD", "development");
  const branch = process.env.GIT_BRANCH && process.env.GIT_BRANCH !== "unknown"
    ? process.env.GIT_BRANCH
    : gitExec("git rev-parse --abbrev-ref HEAD", "");
  const buildTime = process.env.BUILD_TIME && process.env.BUILD_TIME !== "unknown"
    ? process.env.BUILD_TIME
    : new Date().toISOString();
  return { commit, branch, buildTime };
}

const git = getGitInfo();

export default defineConfig({
  plugins: [react()],
  define: {
    __GIT_COMMIT__: JSON.stringify(git.commit),
    __BUILD_TIME__: JSON.stringify(git.buildTime),
    __GIT_BRANCH__: JSON.stringify(git.branch),
    ...(process.env.SCOPE_AUTH_ENABLED !== undefined ? {
      "import.meta.env.VITE_AUTH_ENABLED_LOCAL": JSON.stringify(process.env.SCOPE_AUTH_ENABLED),
    } : {}),
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
