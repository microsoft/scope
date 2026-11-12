// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  ssr: {
    resolve: {
      conditions: ["source"],
    },
  },
  resolve: {
    alias: {
      // Portal uses `@/...` as a shortcut for apps/portal/src/...
      "@/": fileURLToPath(new URL("./apps/portal/src/", import.meta.url)),
    },
  },
  test: {
    include: [".github/workflows/**/*.test.{ts,tsx}", "packages/*/src/**/*.test.{ts,tsx}", "apps/*/src/**/*.test.{ts,tsx}", "apps/workers/*/src/**/*.test.{ts,tsx}", "apps/workers/*/scripts/**/*.test.{ts,tsx}", "apps/model-scanners/*/src/**/*.test.{ts,tsx}", "apps/version-checkers/*/src/**/*.test.{ts,tsx}", "apps/key-updaters/*/src/**/*.test.{ts,tsx}", "scripts/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/.git/**", "**/*.integration.test.ts", "**/*.eval.test.ts"],
    environment: "node",
    globals: false,
    reporters: [
      "github-actions",
      "default",
      [
        "@d2t/vitest-ctrf-json-reporter",
        {
          outputFile: "scope-mt-ctrf-report.json",
          outputDir: "./ctrf",
        },
      ],
    ],
    coverage: {
      reporter: ["text", "json", "json-summary", "html"],
      provider: "v8",
      exclude: [
        "node_modules/",
        "dist/",
        "coverage/",
        "**/*.d.ts",
        "**/*.test.ts",
        "**/*.spec.ts",
      ],
    },
  },
});
