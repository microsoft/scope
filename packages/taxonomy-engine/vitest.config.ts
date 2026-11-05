// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { defineConfig } from "vitest/config";

export default defineConfig({
  ssr: { resolve: { conditions: ["source"] } },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
