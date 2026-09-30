// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import {
  validateParameterDeclarations,
  resolveResourceParams,
  ResourceParameterError,
} from "./resource-params.js";
import type { ResourceParameter } from "../types/resource.js";

const p = (name: string, extra: Partial<ResourceParameter> = {}): ResourceParameter => ({
  name,
  required: false,
  ...extra,
});

describe("validateParameterDeclarations", () => {
  it("accepts an absent or empty declaration", () => {
    expect(() => validateParameterDeclarations(undefined, ["URL"])).not.toThrow();
    expect(() => validateParameterDeclarations([], ["URL"])).not.toThrow();
  });

  it("accepts valid identifiers", () => {
    expect(() => validateParameterDeclarations([p("REPO"), p("_REF2")], ["URL"])).not.toThrow();
  });

  it("rejects names that are not environment variable identifiers", () => {
    expect(() => validateParameterDeclarations([p("my-repo")], [])).toThrow(ResourceParameterError);
    expect(() => validateParameterDeclarations([p("2FAST")], [])).toThrow(/not a valid environment variable name/);
  });

  it("rejects the reserved SCOPE_ prefix so SCOPE_SETUP_ENV cannot be shadowed", () => {
    expect(() => validateParameterDeclarations([p("SCOPE_SETUP_ENV")], [])).toThrow(/reserved/);
  });

  it("rejects a name that is both a parameter and an export", () => {
    expect(() => validateParameterDeclarations([p("MCP_URL")], ["MCP_URL"])).toThrow(
      /both a parameter and an export/
    );
  });

  it("rejects duplicate declarations", () => {
    expect(() => validateParameterDeclarations([p("REPO"), p("REPO")], [])).toThrow(/more than once/);
  });

  it("rejects a required parameter that also has a default", () => {
    expect(() =>
      validateParameterDeclarations([p("REPO", { required: true, default: "a/b" })], [])
    ).toThrow(/can never apply/);
  });

  it("reports every problem at once rather than only the first", () => {
    try {
      validateParameterDeclarations([p("bad-name"), p("SCOPE_X"), p("DUP"), p("DUP")], []);
      throw new Error("expected a throw");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("bad-name");
      expect(message).toContain("SCOPE_X");
      expect(message).toContain("DUP");
    }
  });
});

describe("resolveResourceParams — precedence", () => {
  const parameters = [p("REPO"), p("REF"), p("AS", { default: "demo/ns" })];
  const ref = "github-simulator@r3";

  it("uses the declared default when nothing else supplies a value", () => {
    const { params, conflicts, errors } = resolveResourceParams({ parameters, ref });
    expect(params.AS).toBe("demo/ns");
    expect(conflicts).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("lets a run fill a parameter the profile left open", () => {
    const { params, conflicts, errors } = resolveResourceParams({
      parameters,
      runParams: { REPO: "octo/api" },
      ref,
    });
    expect(params.REPO).toBe("octo/api");
    expect(conflicts).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("prefers the profile value over the declared default", () => {
    const { params } = resolveResourceParams({
      parameters,
      profileParams: { AS: "pinned/ns" },
      ref,
    });
    expect(params.AS).toBe("pinned/ns");
  });

  it("keeps the profile value when the run omits it", () => {
    const { params, conflicts } = resolveResourceParams({
      parameters,
      profileParams: { REPO: "pinned/repo" },
      ref,
    });
    expect(params.REPO).toBe("pinned/repo");
    expect(conflicts).toEqual([]);
  });

  it("accepts a run restating the profile value identically", () => {
    const { params, conflicts } = resolveResourceParams({
      parameters,
      profileParams: { REPO: "pinned/repo" },
      runParams: { REPO: "pinned/repo" },
      ref,
    });
    expect(params.REPO).toBe("pinned/repo");
    expect(conflicts).toEqual([]);
  });

  it("reports a conflict — and keeps the profile value — when a run tries to override", () => {
    const { params, conflicts } = resolveResourceParams({
      parameters,
      profileParams: { AS: "pinned/ns" },
      runParams: { AS: "someone-else/ns" },
      ref,
    });
    expect(conflicts).toEqual([
      'resources.github-simulator@r3.AS: sent "someone-else/ns", profile requires "pinned/ns"',
    ]);
    // The profile still wins in the resolved output; the caller rejects the
    // submission, but a partially-applied override must never be the fallback.
    expect(params.AS).toBe("pinned/ns");
  });

  it("names each conflicting parameter separately rather than the whole binding", () => {
    const { conflicts } = resolveResourceParams({
      parameters,
      profileParams: { REPO: "a/b", AS: "c/d" },
      runParams: { REPO: "x/y", AS: "z/w" },
      ref,
    });
    expect(conflicts).toHaveLength(2);
    expect(conflicts[0]).toContain(".REPO:");
    expect(conflicts[1]).toContain(".AS:");
  });
});

describe("resolveResourceParams — loud failures", () => {
  const parameters = [p("REPO", { required: true }), p("REF")];
  const ref = "github-simulator@r3";

  it("rejects an unknown key from the run instead of ignoring it", () => {
    // The whole point: a silently-dropped REPOS= typo would seed the default and
    // produce a healthy-looking run answering a different question.
    const { errors } = resolveResourceParams({
      parameters,
      runParams: { REPO: "a/b", REPOS: "typo/value" },
      ref,
    });
    expect(errors).toEqual(['resources.github-simulator@r3: unknown parameter "REPOS"']);
  });

  it("rejects an unknown key preset by a profile", () => {
    const { errors } = resolveResourceParams({
      parameters,
      profileParams: { NOPE: "x" },
      runParams: { REPO: "a/b" },
      ref,
    });
    expect(errors).toEqual(['resources.github-simulator@r3: profile presets unknown parameter "NOPE"']);
  });

  it("reports a required parameter that neither profile nor run supplied", () => {
    const { errors } = resolveResourceParams({ parameters, ref });
    expect(errors).toEqual(['resources.github-simulator@r3: missing required parameter "REPO"']);
  });

  it("is satisfied when the profile supplies the required parameter", () => {
    const { errors, params } = resolveResourceParams({
      parameters,
      profileParams: { REPO: "a/b" },
      ref,
    });
    expect(errors).toEqual([]);
    expect(params.REPO).toBe("a/b");
  });

  it("omits optional parameters that have no value at all", () => {
    const { params } = resolveResourceParams({
      parameters,
      profileParams: { REPO: "a/b" },
      ref,
    });
    expect("REF" in params).toBe(false);
  });
});
