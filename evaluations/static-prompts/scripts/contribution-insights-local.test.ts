// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { createLocalGitHubReader, parseLocalOptions } from "./contribution-insights-local.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("local contribution command", () => {
  it.each(["1492", "https://github.com/microsoft/scope/pull/1492"])("accepts the requested PR as %s", (pr) => {
    expect(parseLocalOptions(["--pr", pr])).toMatchObject({
      help: false, prNumber: 1492, model: "auto", timeoutMs: 300_000,
      output: expect.stringContaining("results/contribution-insights-local"),
    });
  });

  it("shows help without authentication or a PR", () => {
    expect(parseLocalOptions(["--help"])).toEqual({ help: true });
  });

  it.each([
    [], ["--pr", "0"], ["--pr", "1492; echo injected"],
    ["--pr", "https://github.com/other/repo/pull/1492"],
    ["--pr", "https://user:password@github.com/microsoft/scope/pull/1492"],
    ["--pr", "1492", "--timeout-seconds", "0"],
    ["--pr", "1492", "--timeout-seconds", "1201"],
    ["--pr", "1492", "--output", ""],
    ["--pr", "1492", "--model", ""],
    ["--pr", "1492", "--publish"],
  ].map((argv) => ({ argv })))("rejects invalid or mutating options: %j", ({ argv }) => {
    expect(() => parseLocalOptions(argv)).toThrow();
  });

  it("supports a leading pnpm argument separator and explicit local controls", () => {
    expect(parseLocalOptions(["--", "--pr", "1492", "--model", "test-model", "--timeout-seconds", "30", "--output", "./tmp/local-report"])).toMatchObject({
      prNumber: 1492, model: "test-model", timeoutMs: 30_000,
      output: fileURLToPath(new URL("../../../tmp/local-report", import.meta.url)),
    });
  });
});

describe("local GitHub reader", () => {
  it("allows only GitHub API GET requests, encoding all route and query values", async () => {
    const fetcher = vi.fn(async (_input: Parameters<typeof fetch>[0], _options?: Parameters<typeof fetch>[1]) =>
      new Response('{"number":1492}', { status: 200 }));
    const github = createLocalGitHubReader("test-token", fetcher);
    const result = await github.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner: "microsoft", repo: "scope", pull_number: 1492, per_page: 100, request: { timeout: 30_000 },
    });
    expect(result.data).toEqual({ number: 1492 });
    const [url, options] = fetcher.mock.calls[0];
    expect(String(url)).toBe("https://api.github.com/repos/microsoft/scope/pulls/1492?per_page=100");
    expect(options).toMatchObject({
      method: "GET", redirect: "error", headers: { Authorization: "Bearer test-token" },
    });
    for (const route of ["POST /repos/microsoft/scope/issues", "GET https://example.invalid/"]) {
      await expect(github.request(route, {})).rejects.toThrow("GET routes");
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not retry permanent authorization failures", async () => {
    const fetcher = vi.fn(async () => new Response("", { status: 403 }));
    await expect(createLocalGitHubReader("test-token", fetcher).request("GET /search/issues", { q: "repo:microsoft/scope" }))
      .rejects.toMatchObject({ status: 403 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("uses bounded retries for transient failures", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let attempt = 0;
    const fetcher = vi.fn(async () => ++attempt === 1
      ? new Response("", { status: 503 })
      : new Response("[]", { status: 200 }));
    const result = createLocalGitHubReader("test-token", fetcher).request("GET /repos/{owner}/{repo}/pulls", { owner: "microsoft", repo: "scope" });
    await vi.runAllTimersAsync();
    expect((await result).data).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("never retries before an excessive Retry-After delay", async () => {
    const fetcher = vi.fn(async () => new Response("", { status: 429, headers: { "Retry-After": "60" } }));
    await expect(createLocalGitHubReader("test-token", fetcher).request("GET /search/issues", { q: "repo:microsoft/scope" }))
      .rejects.toThrow("retry later");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
