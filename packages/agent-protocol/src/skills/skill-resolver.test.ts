// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { encodeGitHubPath, SkillResolver } from "./skill-resolver.js";

describe("encodeGitHubPath", () => {
  it("keeps slashes literal while encoding segments", () => {
    expect(encodeGitHubPath("skills/azure-ai/SKILL.md")).toBe(
      "skills/azure-ai/SKILL.md"
    );
  });

  it("encodes special characters within segments", () => {
    expect(encodeGitHubPath("skills/my skill/SKILL.md")).toBe(
      "skills/my%20skill/SKILL.md"
    );
  });

  it("encodes hash characters in segments", () => {
    expect(encodeGitHubPath("skills/c#-best-practices/SKILL.md")).toBe(
      "skills/c%23-best-practices/SKILL.md"
    );
  });

  it("handles single-segment paths", () => {
    expect(encodeGitHubPath("SKILL.md")).toBe("SKILL.md");
  });

  it("handles deeply nested paths", () => {
    expect(encodeGitHubPath(".agents/skills/cosmosdb-best-practices/SKILL.md")).toBe(
      ".agents/skills/cosmosdb-best-practices/SKILL.md"
    );
  });

  it("handles empty prefix (root-level skill)", () => {
    expect(encodeGitHubPath("cosmosdb-best-practices/SKILL.md")).toBe(
      "cosmosdb-best-practices/SKILL.md"
    );
  });
});

// ---------------------------------------------------------------------------
// SkillResolver.discoverSkills
// ---------------------------------------------------------------------------

describe("SkillResolver.discoverSkills", () => {
  const originalFetch = globalThis.fetch;
  let resolver: SkillResolver;

  beforeEach(() => {
    resolver = new SkillResolver();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  /** Helper: build a Response-like stub. */
  function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
      json: async () => body,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    } as unknown as Response;
  }

  function textResponse(status: number, body: string): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      headers: { get: () => null },
      json: async () => { throw new Error("not json"); },
      text: async () => body,
    } as unknown as Response;
  }

  it("uses the Trees API and returns SKILL.md entries with frontmatter parsed", async () => {
    const skillMd = `---
name: vector-search
description: Vector search skill
---

# Vector Search`;
    const fetchMock = vi.fn(async (input: string) => {
      const url = String(input);
      if (url === "https://api.github.com/repos/owner/repo") {
        return jsonResponse(200, { default_branch: "main" });
      }
      if (url.includes("/git/trees/main?recursive=1")) {
        return jsonResponse(200, {
          tree: [
            { path: "README.md", type: "blob" },
            { path: "skills/vector-search/SKILL.md", type: "blob" },
            { path: "skills/vector-search/script.py", type: "blob" },
            { path: "skills/README.md", type: "blob" }, // not in a skill dir → ignored
          ],
        });
      }
      if (url === "https://raw.githubusercontent.com/owner/repo/main/skills/vector-search/SKILL.md") {
        return textResponse(200, skillMd);
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const results = await resolver.discoverSkills("owner/repo");

    expect(results).toEqual([
      {
        skillName: "vector-search",
        skillPath: "skills/vector-search",
        name: "vector-search",
        description: "Vector search skill",
      },
    ]);
  });

  it("throws when the repository does not exist", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(404, { message: "Not Found" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(resolver.discoverSkills("owner/missing")).rejects.toThrow(
      /Repository "owner\/missing" not found/
    );
  });

  it("surfaces a helpful message on rate-limit (403 with x-ratelimit-remaining: 0)", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(403, { message: "rate limit exceeded" }, { "x-ratelimit-remaining": "0" })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(resolver.discoverSkills("owner/repo")).rejects.toThrow(/rate limit exceeded/i);
  });

  it("returns an entry without metadata when the raw frontmatter fetch fails", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      const url = String(input);
      if (url === "https://api.github.com/repos/owner/repo") {
        return jsonResponse(200, { default_branch: "main" });
      }
      if (url.includes("/git/trees/main?recursive=1")) {
        return jsonResponse(200, {
          tree: [{ path: "skills/broken/SKILL.md", type: "blob" }],
        });
      }
      // Raw fetch fails (e.g. throttled CDN) — should be best-effort.
      if (url.startsWith("https://raw.githubusercontent.com/")) {
        return textResponse(403, "");
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const results = await resolver.discoverSkills("owner/repo");
    expect(results).toEqual([{ skillName: "broken", skillPath: "skills/broken" }]);
  });

  it("matches skills across multiple well-known directories", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      const url = String(input);
      if (url === "https://api.github.com/repos/owner/repo") {
        return jsonResponse(200, { default_branch: "main" });
      }
      if (url.includes("/git/trees/main?recursive=1")) {
        return jsonResponse(200, {
          tree: [
            { path: "skills/dup/SKILL.md", type: "blob" },
            { path: ".agents/skills/dup/SKILL.md", type: "blob" },
            { path: "skills/another/SKILL.md", type: "blob" },
            { path: "node_modules/foo/SKILL.md", type: "blob" }, // not a well-known dir → ignored
          ],
        });
      }
      if (url.startsWith("https://raw.githubusercontent.com/")) {
        return textResponse(200, "# no frontmatter");
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const results = await resolver.discoverSkills("owner/repo");
    expect(results.map((r) => r.skillPath).sort()).toEqual([
      ".agents/skills/dup",
      "skills/another",
      "skills/dup",
    ]);
  });
});
