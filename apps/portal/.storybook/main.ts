// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { StorybookConfig } from "@storybook/react-vite";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  framework: "@storybook/react-vite",
  staticDirs: ["../public"],
  viteFinal: async (config) => {
    config.resolve = config.resolve || {};
    config.resolve.alias = {
      ...config.resolve.alias,
      "@": path.resolve(__dirname, "../src"),
    };
    config.define = {
      ...config.define,
      __GIT_COMMIT__: JSON.stringify("storybook"),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
      __GIT_BRANCH__: JSON.stringify("storybook"),
      // Auth stories use context fixtures, never a live IdP, including in builds.
      "import.meta.env.VITE_AUTH_CLIENT_ID": JSON.stringify("storybook-client-id"),
      "import.meta.env.VITE_AUTH_AUTHORITY": JSON.stringify("https://login.example.test/tenant"),
    };
    return config;
  },
};

export default config;
