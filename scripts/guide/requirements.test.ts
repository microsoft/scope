// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { checkRequirement, checkRequirements, findVariable, type CheckContext } from "./requirements.js";

/**
 * A healthy machine by default: Node 22, every tool installed and working,
 * no credential variables. Tests override only what they exercise.
 */
function fakeContext(overrides: Partial<CheckContext> & { files?: Record<string, string> } = {}): CheckContext {
  const { files = {}, ...rest } = overrides;
  return {
    env: {},
    nodeVersion: "22.22.0",
    onPath: () => true,
    succeeds: () => true,
    output: () => undefined,
    readFile: (path) => files[path],
    ...rest,
  };
}

describe("node", () => {
  it("passes on Node 22 and warns on other versions", () => {
    expect(checkRequirement("node", fakeContext()).status).toBe("ok");

    const result = checkRequirement("node", fakeContext({ nodeVersion: "20.11.0" }));
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("20.11.0");
  });
});

describe("docker", () => {
  it("fails with a specific fix when Docker is missing, stopped, or lacks Compose v2", () => {
    expect(checkRequirement("docker", fakeContext({ onPath: () => false })).detail).toBe("docker is not installed");
    expect(checkRequirement("docker", fakeContext({ succeeds: (_command, args) => args[0] !== "info" })).detail).toContain("daemon is not reachable");
    expect(checkRequirement("docker", fakeContext({ succeeds: (_command, args) => args[0] !== "compose" })).detail).toContain("Compose v2");
  });

  it("passes when the daemon and Compose v2 respond", () => {
    expect(checkRequirement("docker", fakeContext()).status).toBe("ok");
  });
});

describe("github-token", () => {
  it("finds the token in the shell first, then .env.local, then .env", () => {
    expect(checkRequirement("github-token", fakeContext({ env: { GITHUB_TOKEN: "x" } })).detail).toBe("set (shell environment)");
    expect(checkRequirement("github-token", fakeContext({ files: { ".env.local": "GITHUB_TOKEN=x\n", ".env": "GITHUB_TOKEN=y\n" } })).detail).toBe("set (.env.local)");
    expect(checkRequirement("github-token", fakeContext({ files: { ".env": "GITHUB_TOKEN=y\n" } })).detail).toBe("set (.env)");
  });

  it("ignores empty values", () => {
    const context = fakeContext({ env: { GITHUB_TOKEN: "" }, files: { ".env": "GITHUB_TOKEN=\n" }, onPath: (command) => command !== "gh" });
    expect(checkRequirement("github-token", context).status).toBe("fail");
  });

  it("offers the GitHub CLI token when gh is signed in, without exposing it in the result", () => {
    const context = fakeContext({ output: (command, args) => (command === "gh" && args.join(" ") === "auth token" ? "gho_secret" : undefined) });

    const result = checkRequirement("github-token", context);

    expect(result.status).toBe("fail");
    expect(JSON.stringify({ ...result, offer: undefined })).not.toContain("gho_secret");
    expect(result.offer?.resolve()).toEqual({ GITHUB_TOKEN: "gho_secret" });
  });

  it("explains how to sign in when the GitHub CLI is unavailable", () => {
    const result = checkRequirement("github-token", fakeContext({ onPath: (command) => command !== "gh" }));

    expect(result.offer).toBeUndefined();
    expect(result.fix).toContain("gh auth login");
    expect(result.fix).toContain("Copilot entitlement");
  });
});

describe("other checks", () => {
  it("checks ANTHROPIC_API_KEY presence", () => {
    expect(checkRequirement("anthropic-key", fakeContext({ files: { ".env.local": "ANTHROPIC_API_KEY=k" } })).status).toBe("ok");
    expect(checkRequirement("anthropic-key", fakeContext()).status).toBe("fail");
  });

  it("checks mkcert and cargo on PATH", () => {
    expect(checkRequirement("mkcert", fakeContext({ onPath: () => false })).status).toBe("fail");
    expect(checkRequirement("cargo", fakeContext()).status).toBe("ok");
  });

  it("checks for the generated .env file", () => {
    expect(checkRequirement("env-file", fakeContext({ files: { ".env": "" } })).status).toBe("ok");
    expect(checkRequirement("env-file", fakeContext()).fix).toContain("pnpm docker:up:infra");
  });

  it("checks that workspace packages were built for apps run with tsx", () => {
    expect(checkRequirement("packages-built", fakeContext({ files: { "packages/shared/dist/index.js": "" } })).status).toBe("ok");

    const result = checkRequirement("packages-built", fakeContext());
    expect(result.status).toBe("fail");
    expect(result.fix).toContain('pnpm -r --filter "./packages/**" --if-present build');
  });

  it("only warns outside the devcontainer", () => {
    expect(checkRequirement("devcontainer", fakeContext({ env: { SCOPE_DIND_SPIKE: "1" } })).status).toBe("ok");
    expect(checkRequirement("devcontainer", fakeContext()).status).toBe("warn");
  });
});

describe("checkRequirements", () => {
  it("runs each check once, in order", () => {
    const results = checkRequirements(["docker", "mkcert", "docker"], fakeContext());
    expect(results.map((result) => result.id)).toEqual(["docker", "mkcert"]);
  });
});

describe("findVariable", () => {
  it("returns undefined when the variable is nowhere", () => {
    expect(findVariable(fakeContext(), "MISSING")).toBeUndefined();
  });
});
