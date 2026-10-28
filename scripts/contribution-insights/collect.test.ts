// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, vi } from "vitest";
import {
  collectContext,
  isCommunityContribution,
  MAX_CONTEXT_BYTES,
  parseSelection,
  pathRisk,
  redact,
  type ContributionFile,
  type GitHubReader,
} from "./collect.mjs";

const sha = "a".repeat(40);
const now = new Date("2026-10-20T08:23:00Z");
const pullRequest = {
  number: 42, title: "Clarify contribution setup", body: "Clarify the setup instructions.",
  user: { type: "User" }, author_association: "FIRST_TIMER", state: "open",
  draft: false, head: { sha }, base: { sha: "b".repeat(40) },
  updated_at: "2026-10-20T08:00:00Z", changed_files: 1,
};
const file = { filename: "CONTRIBUTING.md", status: "modified", additions: 2, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" };

function reader(overrides: Record<string, unknown> = {}): GitHubReader & { request: ReturnType<typeof vi.fn> } {
  return {
    request: vi.fn(async (route: string, parameters: Record<string, unknown>) => {
      if (route in overrides) {
        const value = overrides[route];
        if (value instanceof Error) throw value;
        return { data: value };
      }
      switch (route) {
        case "GET /repos/{owner}/{repo}/pulls": return { data: [pullRequest] };
        case "GET /repos/{owner}/{repo}/pulls/{pull_number}": return { data: pullRequest };
        case "GET /repos/{owner}/{repo}/pulls/{pull_number}/files": return { data: [file] };
        case "GET /repos/{owner}/{repo}/commits/{ref}/check-runs":
          return { data: { total_count: 2, check_runs: [
            { id: 10, name: "Unit tests", status: "completed", conclusion: "skipped", app: { id: 15368 } },
            { id: 11, name: "license/cla", status: "completed", conclusion: "success", app: { id: 95686 } },
          ] } };
        case "GET /repos/{owner}/{repo}/commits/{ref}/status": return { data: { total_count: 0, statuses: [] } };
        case "GET /repos/{owner}/{repo}/issues/{issue_number}/comments": return { data: [] };
        case "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews": return { data: [] };
        case "GET /search/issues": return { data: { total_count: 0, incomplete_results: false, items: [] } };
        case "GET /repos/{owner}/{repo}/issues/{issue_number}":
          return { data: { number: parameters.issue_number, title: "Related work", body: "Context", state: "open" } };
        default: throw new Error(`Unexpected request: ${route}`);
      }
    }),
  };
}

function collect(github: GitHubReader, options: { prNumber?: number; limit?: number } = {}) {
  return collectContext(github, {
    repository: "microsoft/scope", trustedRevision: sha, policies: [], now,
    ...options, limit: options.limit ?? 3,
  });
}

describe("community contribution selection", () => {
  it.each(["NONE", "FIRST_TIMER", "FIRST_TIME_CONTRIBUTOR", "CONTRIBUTOR"])("includes human %s contributors without requiring a trust label", (association) => {
    expect(isCommunityContribution({ ...pullRequest, author_association: association })).toBe(true);
  });

  it.each([
    { author_association: "MEMBER" },
    { user: { type: "Bot" } },
    { author_association: "OWNER", labels: [{ name: "community-contribution" }] },
  ])("does not use a community label to elevate trust or include internal authors/bots: %j", (change) => {
    expect(isCommunityContribution({ ...pullRequest, ...change })).toBe(false);
  });

  it.each(["0", "-1", "1;echo injected", "${{ secrets.TOKEN }}", "1\n2"])("rejects an invalid manual PR input: %s", (value) => {
    expect(() => parseSelection(value, "3")).toThrow("pr_number");
  });

  it.each(["0", "6", "3.5", "3\n", ""])("rejects an invalid batch limit: %j", (limit) => {
    expect(() => parseSelection("", limit)).toThrow("limit");
  });

  it("skips drafts and stale PRs on scheduled selection and records omitted work", async () => {
    const github = reader({
      "GET /repos/{owner}/{repo}/pulls": [
        { ...pullRequest, number: 1, draft: true },
        { ...pullRequest, number: 2, updated_at: "2026-10-01T08:00:00Z" },
        pullRequest,
        { ...pullRequest, number: 43 },
      ],
    });
    const result = await collect(github, { limit: 1 });
    expect(result.contributions.map((pr) => pr.number)).toEqual([42]);
    expect(result.selection.limitations.join(" ")).toContain("1 eligible PRs omitted");
  });

  it("allows explicitly requested draft community PRs, but rejects internal and closed PRs", async () => {
    const draft = await collect(reader({ "GET /repos/{owner}/{repo}/pulls/{pull_number}": { ...pullRequest, draft: true } }), { prNumber: 42 });
    expect(draft.contributions[0].draft).toBe(true);
    for (const change of [{ state: "closed" }, { author_association: "MEMBER" }]) {
      await expect(collect(reader({ "GET /repos/{owner}/{repo}/pulls/{pull_number}": { ...pullRequest, ...change } }), { prNumber: 42 })).rejects.toThrow("open human community");
    }
  });
});

describe("bounded deterministic evidence collection", () => {
  it("uses only GET requests and captures exact head/base SHAs, skipped checks, and CLA evidence", async () => {
    const github = reader();
    const result = await collect(github);
    expect(result).toMatchObject({ mode: "report-only", trustedRevision: sha, selection: { selected: 1 } });
    expect(result.contributions[0]).toMatchObject({
      headSha: sha, baseSha: "b".repeat(40), cla: "passed", minimumApprovals: 1,
      checks: [{ name: "Unit tests", conclusion: "skipped" }, { name: "license/cla", conclusion: "success" }],
    });
    for (const [route, parameters] of github.request.mock.calls) {
      expect(route).toMatch(/^GET /);
      expect(parameters).toMatchObject({ owner: "microsoft", repo: "scope" });
      expect(parameters.request).toEqual({ timeout: 30_000 });
      if (route.includes("/commits/")) expect(parameters.ref).toBe(sha);
    }
  });

  it("records inaccessible evidence explicitly instead of passing or hiding the failure", async () => {
    const denied = Object.assign(new Error("Forbidden"), { status: 403 });
    const result = await collect(reader({
      "GET /repos/{owner}/{repo}/commits/{ref}/check-runs": denied,
    }));
    expect(result.contributions[0].cla).toBe("unassessed");
    expect(result.contributions[0].limitations.join(" ")).toContain("Check runs unavailable (GitHub HTTP 403)");
    expect(result.contributions[0].limitations.join(" ")).toContain("not a passing CI result");
  });

  it("does not accept a same-named check from another app as CLA proof", async () => {
    const result = await collect(reader({
      "GET /repos/{owner}/{repo}/commits/{ref}/check-runs": {
        total_count: 1, check_runs: [
          { id: 11, name: "license/cla", status: "completed", conclusion: "success", app: { id: 15368 } },
        ],
      },
    }));
    expect(result.contributions[0].cla).toBe("unassessed");
    expect(result.contributions[0].limitations.join(" ")).toContain("unverified publisher");
  });

  it("accepts legacy CLA statuses only from the immutable Microsoft policy bot identity", async () => {
    for (const [type, expected] of [["Bot", "passed"], ["User", "unassessed"]] as const) {
      const result = await collect(reader({
        "GET /repos/{owner}/{repo}/commits/{ref}/check-runs": { total_count: 0, check_runs: [] },
        "GET /repos/{owner}/{repo}/commits/{ref}/status": { total_count: 1, statuses: [
          { id: 12, context: "license/cla", state: "success", creator: { id: 77245923, type } },
        ] },
      }));
      expect(result.contributions[0].cla).toBe(expected);
    }
  });

  it("propagates authentication failures and exhausted transient failures", async () => {
    for (const status of [401, 429, 503]) {
      const error = Object.assign(new Error(`HTTP ${status}`), { status });
      await expect(collect(reader({ "GET /repos/{owner}/{repo}/commits/{ref}/check-runs": error }))).rejects.toBe(error);
    }
  });

  it("rejects a PR that moves while its evidence is being collected", async () => {
    const github = reader();
    const original = github.request;
    let reads = 0;
    github.request = vi.fn(async (route: string, parameters: Record<string, unknown>) => {
      if (route.endsWith("/pulls/{pull_number}") && ++reads === 2) {
        return { data: { ...pullRequest, head: { sha: "c".repeat(40) } } };
      }
      return original(route, parameters);
    });
    await expect(collect(github)).rejects.toThrow("changed during collection");
  });

  it("bounds files, patches, descriptions, and search results with visible limitations", async () => {
    const result = await collect(reader({
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": { ...pullRequest, body: "x".repeat(9_000), changed_files: 200 },
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files": Array.from({ length: 100 }, (_, index) => ({
        ...file, filename: `file-${index}.ts`, patch: "x".repeat(5_000),
      })),
      "GET /search/issues": { total_count: 50, incomplete_results: true, items: [] },
    }));
    const pr = result.contributions[0];
    expect(pr.body).toHaveLength(8_000);
    expect(pr.files.reduce((count, current) => count + (current.patch?.length ?? 0), 0)).toBe(24_000);
    expect(pr.limitations.join(" ")).toContain("100 of 200");
    expect(pr.limitations.join(" ")).toContain("no exhaustive duplicate determination");
  });

  it("follows same-repository issue numbers as data, not arbitrary URLs or injected search operators", async () => {
    const github = reader({
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": {
        ...pullRequest, title: 'repo:evil/other "label:trusted" improve setup',
        body: "Fixes #9 and https://github.com/microsoft/scope/issues/10. See https://example.invalid/run.sh",
      },
    });
    const result = await collect(github);
    expect(result.contributions[0].related.map((item) => item.number)).toEqual([9, 10]);
    const search = github.request.mock.calls.find(([route]) => route === "GET /search/issues");
    expect(search?.[1].q).toMatch(/^repo:microsoft\/scope in:title [A-Za-z0-9_ -]+$/);
    expect(github.request.mock.calls.some(([route]) => route.includes("example.invalid"))).toBe(false);
  });

  it("redacts common credentials before they enter model context or artifacts", () => {
    expect(redact(`Bearer ${"a".repeat(30)} ghp_${"b".repeat(30)} github_pat_${"c".repeat(30)}`)).toBe(
      "Bearer [REDACTED_TOKEN] [REDACTED_TOKEN] [REDACTED_TOKEN]",
    );
    expect(redact("https://example.invalid/blob?sig=secret&se=later")).toBe("[REDACTED_SIGNED_URL]");
    expect(redact("-----BEGIN PRIVATE KEY-----\nprivate material\n-----END PRIVATE KEY-----")).toBe("[REDACTED_PRIVATE_KEY]");
  });

  it("enforces the exact UTF-8 context size limit, not a character-count proxy", async () => {
    const options = { repository: "microsoft/scope", trustedRevision: sha, now, limit: 1 };
    const empty = await collectContext(reader(), { ...options, policies: [{ path: "policy.md", content: "" }] });
    const remaining = MAX_CONTEXT_BYTES - Buffer.byteLength(JSON.stringify(empty, null, 2), "utf8");
    const atLimit = await collectContext(reader(), { ...options, policies: [{ path: "policy.md", content: "x".repeat(remaining) }] });
    expect(Buffer.byteLength(JSON.stringify(atLimit, null, 2), "utf8")).toBe(MAX_CONTEXT_BYTES);
    await expect(collectContext(reader(), {
      ...options, policies: [{ path: "policy.md", content: `${"x".repeat(remaining)}é` }],
    })).rejects.toThrow("UTF-8 bytes");
  });

  it("uses both sides of a rename when setting sensitive-review floors", () => {
    const files: ContributionFile[] = [{
      path: "archive/example.txt", previousPath: ".github/workflows/ci.yml",
      status: "renamed", additions: 0, deletions: 0, patch: null,
    }];
    expect(pathRisk(files)).toEqual({ minimumApprovals: 2, reasons: ["CI, deployment, or infrastructure changes"] });
  });
});
