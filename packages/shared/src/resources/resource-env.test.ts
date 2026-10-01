// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { parseResourceEnv, missingExports, exportCollisions } from "./resource-env.js";
import {
  interpolateMcpServerConfig,
  interpolateMcpServerConfigs,
  referencedPlaceholders,
  UnresolvedPlaceholderError,
} from "./resource-interpolate.js";
import type { McpServerConfig } from "../types/mcp.js";

const base: McpServerConfig = {
  slug: "github-emulated",
  name: "GitHub (emulated)",
  type: "http",
};

describe("parseResourceEnv", () => {
  it("parses simple assignments", () => {
    const { values, errors } = parseResourceEnv("A=1\nB=two\n");
    expect(values).toEqual({ A: "1", B: "two" });
    expect(errors).toEqual([]);
  });

  // Connection strings and URLs routinely contain '='; splitting on every '='
  // would silently truncate them.
  it("splits on the first = only", () => {
    const { values } = parseResourceEnv("URL=http://h/p?a=1&b=2\n");
    expect(values.URL).toBe("http://h/p?a=1&b=2");
  });

  it("tolerates CRLF", () => {
    const { values, errors } = parseResourceEnv("A=1\r\nB=2\r\n");
    expect(values).toEqual({ A: "1", B: "2" });
    expect(errors).toEqual([]);
  });

  it("ignores blank lines and comments", () => {
    const { values, errors } = parseResourceEnv("\n# a comment\n\nA=1\n");
    expect(values).toEqual({ A: "1" });
    expect(errors).toEqual([]);
  });

  it("preserves an empty value", () => {
    const { values, errors } = parseResourceEnv("EMPTY=\n");
    expect(values).toEqual({ EMPTY: "" });
    expect(errors).toEqual([]);
  });

  // A skipped malformed line would surface far away as an unresolved ${VAR}.
  it("reports malformed lines instead of skipping them", () => {
    const { values, errors } = parseResourceEnv("GOOD=1\nnonsense\n=novalue\n9BAD=x\n");
    expect(values).toEqual({ GOOD: "1" });
    expect(errors.map((e) => e.line)).toEqual([2, 3, 4]);
    expect(errors[0].reason).toMatch(/missing '='/);
    expect(errors[1].reason).toMatch(/empty variable name/);
    expect(errors[2].reason).toMatch(/invalid variable name/);
  });

  it("lets a later assignment win, like a shell would", () => {
    expect(parseResourceEnv("A=1\nA=2\n").values.A).toBe("2");
  });
});

describe("missingExports", () => {
  it("names what was promised but not published", () => {
    expect(missingExports(["A", "B"], { A: "1" })).toEqual(["B"]);
  });

  it("treats an empty published value as published", () => {
    expect(missingExports(["A"], { A: "" })).toEqual([]);
  });
});

describe("exportCollisions", () => {
  // Last-one-wins would make the environment depend on reference order invisibly.
  it("detects a name published by two resources", () => {
    const found = exportCollisions([
      { slug: "sim", names: ["URL", "TOKEN"] },
      { slug: "db", names: ["URL"] },
    ]);
    expect(found).toEqual([{ name: "URL", slugs: ["sim", "db"] }]);
  });

  it("is quiet when names are disjoint", () => {
    expect(
      exportCollisions([
        { slug: "sim", names: ["A"] },
        { slug: "db", names: ["B"] },
      ]),
    ).toEqual([]);
  });
});

describe("interpolateMcpServerConfig", () => {
  it("substitutes into url and header values", () => {
    const out = interpolateMcpServerConfig(
      {
        ...base,
        url: "${MCP_URL}",
        headers: [{ name: "Authorization", value: "Bearer ${SIM_TOKEN}" }],
      },
      { MCP_URL: "http://host.docker.internal:18082/mcp", SIM_TOKEN: "ghp_abc" },
    );
    expect(out.url).toBe("http://host.docker.internal:18082/mcp");
    expect(out.headers?.[0].value).toBe("Bearer ghp_abc");
  });

  it("substitutes into stdio command, args and env", () => {
    const out = interpolateMcpServerConfig(
      {
        ...base,
        type: "stdio",
        command: "${BIN}",
        args: ["--host", "${SIM_URL}"],
        env: { GITHUB_HOST: "${SIM_URL}", GITHUB_PERSONAL_ACCESS_TOKEN: "${SIM_TOKEN}" },
      },
      { BIN: "github-mcp-server", SIM_URL: "http://localhost:18080", SIM_TOKEN: "ghp_abc" },
    );
    expect(out.command).toBe("github-mcp-server");
    expect(out.args).toEqual(["--host", "http://localhost:18080"]);
    expect(out.env).toEqual({
      GITHUB_HOST: "http://localhost:18080",
      GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_abc",
    });
  });

  // Passing ${MCP_URL} through literally fails much later, inside the gateway,
  // as an opaque transport error.
  it("throws naming every unresolved placeholder at once", () => {
    expect(() =>
      interpolateMcpServerConfig(
        { ...base, url: "${MCP_URL}", headers: [{ name: "A", value: "${SIM_TOKEN}" }] },
        { OTHER: "x" },
      ),
    ).toThrow(UnresolvedPlaceholderError);

    try {
      interpolateMcpServerConfig({ ...base, url: "${MCP_URL}" }, { OTHER: "x" });
    } catch (e) {
      const err = e as UnresolvedPlaceholderError;
      expect(err.names).toEqual(["MCP_URL"]);
      expect(err.serverName).toBe("GitHub (emulated)");
      expect(err.message).toContain("Available: OTHER");
    }
  });

  it("leaves a config with no placeholders untouched", () => {
    const cfg = { ...base, url: "http://example.test/mcp" };
    expect(interpolateMcpServerConfig(cfg, {})).toEqual(cfg);
  });

  it("does not invent fields that were absent", () => {
    const out = interpolateMcpServerConfig({ ...base, url: "http://x/" }, {});
    expect("env" in out).toBe(false);
    expect("headers" in out).toBe(false);
  });
});

describe("interpolateMcpServerConfigs", () => {
  it("fails the batch if any server is unresolved", () => {
    expect(() =>
      interpolateMcpServerConfigs(
        [
          { ...base, slug: "a", url: "http://ok/" },
          { ...base, slug: "b", url: "${NOPE}" },
        ],
        {},
      ),
    ).toThrow(UnresolvedPlaceholderError);
  });
});

describe("referencedPlaceholders", () => {
  it("collects names across transports and fields", () => {
    expect(
      referencedPlaceholders([
        { ...base, url: "${MCP_URL}", headers: [{ name: "A", value: "Bearer ${TOK}" }] },
        { ...base, slug: "s", type: "stdio", args: ["${ARG}"], env: { X: "${TOK}" } },
      ]),
    ).toEqual(["ARG", "MCP_URL", "TOK"]);
  });
});
