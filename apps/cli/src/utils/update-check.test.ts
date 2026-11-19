// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { execSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execSync: vi.fn() }));

describe("public CLI release lookup", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("SCOPE_RELEASES_URL", "");
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("SCOPE_TOKEN", "scope-service-token");
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("uses the public repository anonymously when gh is unavailable, without leaking the Scope bearer", async () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error("gh unavailable"); });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify([{ tag_name: "cli/v1.2.3" }])));
    vi.stubGlobal("fetch", fetchMock);
    const { RELEASES_REPO, RELEASES_URL, fetchLatestVersion } = await import("./update-check.js");
    expect(RELEASES_REPO).toBe("microsoft/scope");
    expect(RELEASES_URL).toBe("https://api.github.com/repos/microsoft/scope/releases");
    expect(await fetchLatestVersion()).toBe("1.2.3");
    expect(fetchMock).toHaveBeenCalledWith(RELEASES_URL, {
      signal: expect.any(AbortSignal),
      headers: { Accept: "application/vnd.github.v3+json" },
    });
  });

  it("targets the same public repository through gh when available", async () => {
    vi.mocked(execSync).mockReturnValue("cli/v2.0.0\n");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const { fetchLatestVersion } = await import("./update-check.js");
    expect(await fetchLatestVersion()).toBe("2.0.0");
    expect(execSync).toHaveBeenCalledWith(expect.stringContaining("gh release list --repo microsoft/scope"), expect.anything());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves a custom releases URL without invoking gh", async () => {
    vi.stubEnv("SCOPE_RELEASES_URL", "http://localhost:9999/releases");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json([{ tag_name: "cli/v2.0.0" }]));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchLatestVersion } = await import("./update-check.js");
    expect(await fetchLatestVersion()).toBe("2.0.0");
    expect(execSync).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:9999/releases", expect.anything());
  });

  it("returns no version when no CLI release has been published", async () => {
    vi.mocked(execSync).mockReturnValue("");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json([{ tag_name: "other/v9.0.0" }]));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchLatestVersion } = await import("./update-check.js");
    expect(await fetchLatestVersion()).toBeUndefined();
  });
});
