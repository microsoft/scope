// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { execSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

const mockedExecSync = vi.mocked(execSync);
const mockedFetch = vi.fn<typeof fetch>();

describe("CLI release source", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.stubEnv("SCOPE_RELEASES_URL", "");
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubGlobal("fetch", mockedFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("queries microsoft/scope with gh", async () => {
    mockedExecSync.mockReturnValue("cli/v1.2.3\n");
    const { fetchLatestVersion, RELEASES_REPO } = await import("./update-check.js");

    expect(RELEASES_REPO).toBe("microsoft/scope");
    expect(await fetchLatestVersion()).toBe("1.2.3");
    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining("gh release list --repo microsoft/scope"),
      expect.anything(),
    );
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("uses the same repository for the REST fallback", async () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("gh unavailable");
    });
    mockedFetch.mockResolvedValue(Response.json([
      { tag_name: "other/v9.0.0" },
      { tag_name: "cli/v1.2.3" },
    ]));
    const { fetchLatestVersion } = await import("./update-check.js");

    expect(await fetchLatestVersion()).toBe("1.2.3");
    expect(mockedFetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/microsoft/scope/releases",
      expect.anything(),
    );
  });

  it("preserves the custom releases URL without invoking gh", async () => {
    vi.stubEnv("SCOPE_RELEASES_URL", "http://localhost:9999/releases");
    mockedFetch.mockResolvedValue(Response.json([{ tag_name: "cli/v2.0.0" }]));
    const { fetchLatestVersion } = await import("./update-check.js");

    expect(await fetchLatestVersion()).toBe("2.0.0");
    expect(mockedExecSync).not.toHaveBeenCalled();
    expect(mockedFetch).toHaveBeenCalledWith(
      "http://localhost:9999/releases",
      expect.anything(),
    );
  });

  it("returns no version when no CLI release has been published", async () => {
    mockedExecSync.mockReturnValue("");
    const { fetchLatestVersion } = await import("./update-check.js");

    expect(await fetchLatestVersion()).toBeUndefined();
  });
});
