// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHandlerRegistry,
  HandlerRegistry,
  TAXONOME_PLUGIN_API_VERSION,
} from "./handlers.js";
import { loadPlugins } from "./plugins.js";

const directories: string[] = [];

/** Creates an owned project root for local/package plugin resolution tests. */
async function project(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "taxonome-plugin-"));
  directories.push(directory);
  await writeFile(join(directory, "package.json"), '{"name":"fixture-project","type":"module"}');
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("explicit Taxonome plugins", () => {
  it("loads a compiled local entry point and resolves its dependencies from the plugin location", async () => {
    const cwd = await project();
    await mkdir(join(cwd, "dist"));
    await writeFile(
      join(cwd, "dist", "helper.mjs"),
      'export const observed = {state:"completed",observed:true,occurrences:[{related_turns:[1],tool_call_id:"custom"}]};',
    );
    await writeFile(
      join(cwd, "dist", "handlers.mjs"),
      `import { observed } from "./helper.mjs";
export const taxonomePlugin = {
  api_version: "${TAXONOME_PLUGIN_API_VERSION}",
  provider: { name: "acme-local", version: "1.0.0" },
  handlers: {
    "acme/custom-v1": {
      configSchema: { parse(value) { return value ?? {}; } },
      evaluate() { return observed; }
    }
  }
};`,
    );

    const registry = createHandlerRegistry();
    await loadPlugins(["./dist/handlers.mjs"], cwd, registry);
    const registered = registry.resolve("acme/custom-v1");

    expect(registered.provider).toMatchObject({
      name: "acme-local",
      version: "1.0.0",
      origin: "local",
    });
    expect(registered.provider.entry).toBe("./dist/handlers.mjs");
    expect(registered.provider.integrity).toMatch(/^[a-f0-9]{64}$/);
    expect(registered.handler.evaluate({} as never, {})).toMatchObject({
      state: "completed",
      observed: true,
    });
  });

  it("resolves an installed package export from invocation cwd rather than the CLI installation", async () => {
    const cwd = await project();
    const packageRoot = join(cwd, "node_modules", "@acme", "taxonome-handlers");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({
      name: "@acme/taxonome-handlers",
      version: "2.3.4",
      type: "module",
      exports: "./index.mjs",
    }));
    await writeFile(join(packageRoot, "index.mjs"), `
export default {
  api_version: "${TAXONOME_PLUGIN_API_VERSION}",
  provider: { name: "@acme/taxonome-handlers" },
  handlers: {
    "acme/package-v1": {
      configSchema: { parse(value) { return value ?? {}; } },
      evaluate() { return {state:"completed",observed:false}; }
    }
  }
};`);

    const registry = createHandlerRegistry();
    await loadPlugins(["@acme/taxonome-handlers"], cwd, registry);
    expect(registry.resolve("acme/package-v1").provider).toMatchObject({
      name: "@acme/taxonome-handlers",
      version: "2.3.4",
      origin: "package",
    });
  });

  it("rejects reserved scope IDs, duplicates, unknown API versions, and unselected packages", async () => {
    const cwd = await project();
    const writePlugin = async (name: string, body: string) => {
      const path = join(cwd, `${name}.mjs`);
      await writeFile(path, body);
      return `./${name}.mjs`;
    };
    const reserved = await writePlugin("reserved", `
export default {api_version:"${TAXONOME_PLUGIN_API_VERSION}",provider:{name:"bad"},handlers:{
  "scope/timeout-v1":{configSchema:{parse(v){return v}},evaluate(){return {}}}
}};`);
    await expect(loadPlugins(
      [reserved],
      cwd,
      createHandlerRegistry(),
    )).rejects.toThrow("reserved handler ID");

    const duplicate = await writePlugin("duplicate", `
export default {api_version:"${TAXONOME_PLUGIN_API_VERSION}",provider:{name:"dup"},handlers:{
  "acme/dup-v1":{configSchema:{parse(v){return v}},evaluate(){return {}}}
}};`);
    const registry = new HandlerRegistry();
    await loadPlugins([duplicate], cwd, registry);
    await expect(loadPlugins([duplicate], cwd, registry))
      .rejects.toThrow("Duplicate deterministic handler ID");

    const invalid = await writePlugin("invalid", `
export default {api_version:"scope/taxonome-plugin/v0",provider:{name:"old"},handlers:{}};`);
    await expect(loadPlugins([invalid], cwd, new HandlerRegistry()))
      .rejects.toThrow(TAXONOME_PLUGIN_API_VERSION);

    await expect(loadPlugins(
      ["@acme/not-installed"],
      cwd,
      new HandlerRegistry(),
    )).rejects.toThrow();
  });
});
