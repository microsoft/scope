// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { build, type Plugin } from "esbuild";
import { chmodSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));

// ESM banner: shebang + createRequire polyfill for CJS deps (e.g. dotenv uses require("fs"))
const banner = `#!/usr/bin/env node
import { createRequire as __createRequire } from "module";
import { fileURLToPath as __fileURLToPath } from "url";
import { dirname as __dirname_ } from "path";
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_(__filename);
`;

const stripShebang: Plugin = {
  name: "strip-shebang",
  setup(b) {
    b.onLoad({ filter: /index\.ts$/ }, async (args) => {
      let contents = readFileSync(args.path, "utf-8");
      if (contents.startsWith("#!")) {
        contents = contents.replace(/^#![^\n]*\n/, "");
      }
      return { contents, loader: "ts" };
    });
  },
};

const shimReactDevtools: Plugin = {
  name: "shim-react-devtools",
  setup(b) {
    b.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: "react-devtools-core",
      namespace: "shim",
    }));
    b.onLoad({ filter: /.*/, namespace: "shim" }, () => ({
      contents: "export default undefined;",
      loader: "js",
    }));
  },
};

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/scope.mjs",
  minify: true,
  treeShaking: true,
  banner: { js: banner },
  define: {
    "process.env.SCOPE_CLI_VERSION": JSON.stringify(pkg.version),
  },
  external: [],
  logLevel: "warning",
  plugins: [stripShebang, shimReactDevtools],
});

console.log(`✓ Built dist/scope.mjs (v${pkg.version})`);

chmodSync("dist/scope.mjs", 0o755);
