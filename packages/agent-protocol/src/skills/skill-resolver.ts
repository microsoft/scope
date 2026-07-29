// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Skill Resolver — fetches skill content from GitHub and creates skill revisions.
 *
 * Resolution flow:
 * 1. Discover the skill directory in the GitHub repo using the Trees API
 * 2. Get the latest commit touching the skill directory
 * 3. Download skill directory files (SKILL.md + supporting files)
 * 4. Archive as tar.gz and upload to blob storage
 * 5. Parse SKILL.md and validate per Agent Skills spec
 * 6. Create or retrieve SkillRevisionDocument via the store
 */

import { parseSkillMd } from './skill-parser.js';
import { validateSkillFrontmatter } from './skill-validator.js';
import { buildSkillRevisionRef } from './skill-revision-id.js';
import { SkillRevisionStore } from './skill-revision-store.js';
import type { SkillRevisionDocument } from '@scope/core';

/** Options for the skill resolver */
export interface SkillResolverOptions {
  /** GitHub API base URL (default: https://api.github.com) */
  githubApiUrl?: string;
  /**
   * Static GitHub token for authentication (optional, increases rate limits).
   * Mutually compatible with `tokenProvider` — if both are provided,
   * `tokenProvider` takes precedence per request.
   */
  githubToken?: string;
  /**
   * Async token provider, called once per request batch. Lets the resolver
   * acquire round-robin tokens from the token manager (with env-var fallback)
   * instead of being pinned to a single token at construction time.
   * If it resolves to `undefined`, the request is sent unauthenticated.
   */
  tokenProvider?: () => Promise<string | undefined>;
}

/** A file entry discovered in a skill directory */
interface SkillFileEntry {
  path: string;       // Path relative to skill directory (e.g. "SKILL.md", "scripts/extract.py")
  content: string;    // File content (text)
}

/** A skill discovered by scanning a repo's well-known directories */
export interface SkillDiscoveryEntry {
  /** Directory name of the skill (last path segment) */
  skillName: string;
  /** Full path within the repo where the skill directory lives */
  skillPath: string;
  /** Display name from SKILL.md frontmatter (best-effort) */
  name?: string;
  /** Description from SKILL.md frontmatter (best-effort) */
  description?: string;
}

/**
 * Well-known directories to search for skills in a GitHub repo,
 * per the skills.sh CLI discovery order.
 */
const SKILL_SEARCH_DIRS = [
  'skills',
  '.agents/skills',
  '.github/skills',
  '.claude/skills',
  '.copilot/skills',
  '.roo/skills',
  '.cursor/skills',
  '', // root-level skill directories
];

/**
 * Encode a file path for use in GitHub Contents API URLs.
 * Encodes each segment individually (handling special chars like spaces, #)
 * while keeping literal slashes so the API can parse the path correctly.
 *
 * Using plain encodeURIComponent on the full path would turn
 * "skills/azure-ai/SKILL.md" into "skills%2Fazure-ai%2FSKILL.md",
 * which GitHub returns 404 for.
 */
export function encodeGitHubPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/**
 * Resolves a skill from a GitHub repository and creates/retrieves a SkillRevisionDocument.
 */
export class SkillResolver {
  private readonly githubApiUrl: string;
  private readonly baseHeaders: Record<string, string>;
  private readonly staticToken?: string;
  private readonly tokenProvider?: () => Promise<string | undefined>;

  constructor(options?: SkillResolverOptions) {
    this.githubApiUrl = options?.githubApiUrl?.replace(/\/+$/, '') ?? 'https://api.github.com';
    this.baseHeaders = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'scope-mt-skill-resolver',
    };
    this.staticToken = options?.githubToken;
    this.tokenProvider = options?.tokenProvider;
  }

  /**
   * Build request headers, acquiring a fresh token via `tokenProvider` if
   * configured (so each request can use a different round-robin token).
   * Falls back to the static `githubToken` from construction.
   */
  private async getHeaders(): Promise<Record<string, string>> {
    let token: string | undefined;
    if (this.tokenProvider) {
      try {
        token = await this.tokenProvider();
      } catch {
        // Provider failure is non-fatal — fall through to static token / unauth
      }
    }
    if (!token) token = this.staticToken;
    if (!token) return this.baseHeaders;
    return { ...this.baseHeaders, Authorization: `Bearer ${token}` };
  }

  /**
   * Resolve a skill from a GitHub repo, returning an existing or newly created SkillRevisionDocument.
   *
   * @param source - GitHub repo (e.g. "vercel-labs/agent-skills")
   * @param skillName - Skill name (e.g. "vercel-react-best-practices")
   * @param store - SkillRevisionStore for persistence
   * @param uploadArchive - Function to upload a tar.gz archive and return its URL
   * @returns The SkillRevisionDocument for this skill at its latest commit
   */
  async resolve(
    source: string,
    skillName: string,
    store: SkillRevisionStore,
    uploadArchive: (name: string, data: Buffer) => Promise<string>
  ): Promise<SkillRevisionDocument> {
    // 1. Discover the skill directory path in the repo
    const skillPath = await this.discoverSkillPath(source, skillName);
    if (!skillPath) {
      throw new Error(`Skill "${skillName}" not found in repository "${source}". Searched well-known directories.`);
    }

    // 2. Get the latest commit touching the skill directory
    const commitInfo = await this.getLatestCommit(source, skillPath);

    // 3. Check if we already have this revision
    const ref = buildSkillRevisionRef(source, skillName, commitInfo.sha);
    const existing = await store.getByRef(ref);
    if (existing) {
      return existing;
    }

    // 4. Download skill directory files
    const files = await this.downloadSkillFiles(source, skillPath, commitInfo.sha);

    // 5. Find and parse SKILL.md
    const skillMdFile = files.find(f => f.path === 'SKILL.md');
    if (!skillMdFile) {
      throw new Error(`SKILL.md not found in ${source}/${skillPath} at commit ${commitInfo.sha}`);
    }

    const parsed = parseSkillMd(skillMdFile.content);

    // 6. Validate per spec (use actual directory name from discovered path)
    const dirName = skillPath.split('/').pop()!;
    const validation = validateSkillFrontmatter(parsed.frontmatter, dirName);
    if (!validation.valid) {
      const errorMessages = validation.errors.map(e => `${e.field}: ${e.message}`).join('; ');
      throw new Error(`Invalid SKILL.md in ${source}/${skillPath}: ${errorMessages}`);
    }
    const validationWarnings = validation.warnings.map(w => `${w.field}: ${w.message}`);

    // 7. Create tar.gz archive and upload
    const archiveData = await this.createArchive(skillName, files);
    const archiveUrl = await uploadArchive(`skill-revisions/${skillName}-${commitInfo.sha.slice(0, 8)}.tar.gz`, archiveData);

    // 8. Store the revision
    const now = new Date();
    return store.findOrCreate({
      ref,
      source,
      skillName,
      skillPath,
      commitHash: commitInfo.sha,
      commitTimestamp: commitInfo.date,
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      license: parsed.frontmatter.license,
      compatibility: parsed.frontmatter.compatibility,
      allowedTools: parsed.frontmatter.allowedTools,
      metadata: parsed.frontmatter.metadata,
      content: skillMdFile.content,
      archiveUrl,
      ...(validationWarnings.length > 0 ? { validationWarnings } : {}),
      resolvedAt: now,
    });
  }

  /**
   * Discover where the skill directory lives in the repo.
   * Searches well-known locations for a directory named `skillName` containing SKILL.md.
   */
  async discoverSkillPath(source: string, skillName: string): Promise<string | null> {
    const headers = await this.getHeaders();
    // Try each well-known directory
    for (const searchDir of SKILL_SEARCH_DIRS) {
      const candidatePath = searchDir ? `${searchDir}/${skillName}` : skillName;
      const skillMdPath = `${candidatePath}/SKILL.md`;

      try {
        const url = `${this.githubApiUrl}/repos/${source}/contents/${encodeGitHubPath(skillMdPath)}`;
        const res = await fetch(url, { headers });
        if (res.ok) {
          return candidatePath;
        }
      } catch {
        // Continue searching
      }
    }

    return null;
  }

  /**
   * List all skills available in a repo by scanning well-known directories.
   *
   * Uses the GitHub Trees API recursively (a single API call) to enumerate the
   * entire repo, then filters for `SKILL.md` files inside well-known parent
   * directories. Frontmatter (name, description) is parsed best-effort in
   * parallel — if a fetch fails (rate limit, etc.) the entry is still returned
   * with `skillName` only.
   *
   * @throws if the repo itself cannot be accessed (404, rate limit, etc.).
   */
  async discoverSkills(source: string): Promise<SkillDiscoveryEntry[]> {
    const headers = await this.getHeaders();
    // 1. Get the default branch (a single repo metadata call).
    const repoRes = await fetch(`${this.githubApiUrl}/repos/${source}`, { headers });
    if (repoRes.status === 404) {
      throw new Error(`Repository "${source}" not found`);
    }
    if (!repoRes.ok) {
      const detail = await this.formatGitHubError(repoRes);
      throw new Error(`Failed to access repository "${source}": ${detail}`);
    }
    const repoJson = await repoRes.json() as { default_branch?: string };
    const branch = repoJson.default_branch ?? 'main';

    // 2. Fetch the recursive tree (a single API call).
    const treeUrl = `${this.githubApiUrl}/repos/${source}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
    const treeRes = await fetch(treeUrl, { headers });
    if (!treeRes.ok) {
      const detail = await this.formatGitHubError(treeRes);
      throw new Error(`Failed to list ${source} tree: ${detail}`);
    }
    const treeJson = await treeRes.json() as {
      tree?: Array<{ path: string; type: 'blob' | 'tree' }>;
      truncated?: boolean;
    };
    if (!treeJson.tree) return [];

    // 3. Filter for SKILL.md files inside well-known parent dirs.
    const seen = new Set<string>();
    const candidates: SkillDiscoveryEntry[] = [];
    for (const entry of treeJson.tree) {
      if (entry.type !== 'blob') continue;
      if (!entry.path.endsWith('/SKILL.md') && entry.path !== 'SKILL.md') continue;

      const skillPath = entry.path === 'SKILL.md' ? '' : entry.path.slice(0, -'/SKILL.md'.length);
      const parentDir = skillPath.includes('/') ? skillPath.slice(0, skillPath.lastIndexOf('/')) : '';
      const skillName = skillPath.includes('/') ? skillPath.slice(skillPath.lastIndexOf('/') + 1) : skillPath;

      // Match against well-known parent directories.
      if (!SKILL_SEARCH_DIRS.includes(parentDir)) continue;
      // Skip dot-prefixed dirs at the repo root (e.g. .github/workflows/SKILL.md if any).
      if (!parentDir && skillName.startsWith('.')) continue;
      if (!skillName) continue;

      if (seen.has(skillPath)) continue;
      seen.add(skillPath);

      candidates.push({ skillName, skillPath });
    }

    // 4. Best-effort parallel frontmatter fetch (raw.githubusercontent.com avoids
    //    counting against the API rate limit).
    await Promise.all(
      candidates.map(async (c) => {
        try {
          const rawUrl = `https://raw.githubusercontent.com/${source}/${encodeURIComponent(branch)}/${encodeGitHubPath(`${c.skillPath}/SKILL.md`)}`;
          const res = await fetch(rawUrl);
          if (!res.ok) return;
          const content = await res.text();
          const parsed = parseSkillMd(content);
          if (parsed.frontmatter.name) c.name = parsed.frontmatter.name;
          if (parsed.frontmatter.description) c.description = parsed.frontmatter.description;
        } catch {
          // Non-fatal: return entry without metadata.
        }
      })
    );

    candidates.sort((a, b) => a.skillName.localeCompare(b.skillName));
    return candidates;
  }

  /** Format a non-OK GitHub response, surfacing rate-limit info when possible. */
  private async formatGitHubError(res: Response): Promise<string> {
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (res.status === 403 && remaining === '0') {
      return `403 rate limit exceeded — set GITHUB_TOKEN to raise the limit`;
    }
    let body = '';
    try { body = (await res.text()).slice(0, 200); } catch { /* ignore */ }
    return `${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`;
  }

  /**
   * Get the SHA of the latest commit touching the skill directory.
   * Public wrapper around the resolver's internal commit lookup so route
   * handlers can compare upstream state against stored revisions.
   */
  async getLatestCommitSha(source: string, skillPath: string): Promise<string> {
    return (await this.getLatestCommit(source, skillPath)).sha;
  }

  /**
   * Get the latest commit touching the skill directory.
   */
  private async getLatestCommit(
    source: string,
    skillPath: string
  ): Promise<{ sha: string; date: Date }> {
    const url = `${this.githubApiUrl}/repos/${source}/commits?path=${encodeURIComponent(skillPath)}&per_page=1`;
    const res = await fetch(url, { headers: await this.getHeaders() });

    if (!res.ok) {
      throw new Error(`Failed to get commits for ${source}/${skillPath}: ${res.status} ${res.statusText}`);
    }

    const commits = await res.json() as Array<{
      sha: string;
      commit: { committer: { date: string } };
    }>;

    if (commits.length === 0) {
      throw new Error(`No commits found for path ${skillPath} in ${source}`);
    }

    return {
      sha: commits[0].sha,
      date: new Date(commits[0].commit.committer.date),
    };
  }

  /**
   * Download all files in the skill directory at a specific commit.
   * Returns paths relative to the skill directory root.
   */
  private async downloadSkillFiles(
    source: string,
    skillPath: string,
    commitSha: string
  ): Promise<SkillFileEntry[]> {
    const headers = await this.getHeaders();
    // Get the directory listing at the specific commit
    const url = `${this.githubApiUrl}/repos/${source}/contents/${encodeGitHubPath(skillPath)}?ref=${commitSha}`;
    const res = await fetch(url, { headers });

    if (!res.ok) {
      throw new Error(`Failed to list ${source}/${skillPath} at ${commitSha}: ${res.status} ${res.statusText}`);
    }

    const entries = await res.json() as Array<{
      name: string;
      path: string;
      type: 'file' | 'dir';
      download_url: string | null;
    }>;

    const files: SkillFileEntry[] = [];

    for (const entry of entries) {
      if (entry.type === 'file' && entry.download_url) {
        const fileRes = await fetch(entry.download_url, { headers });
        if (fileRes.ok) {
          const content = await fileRes.text();
          // Path relative to skill directory
          const relativePath = entry.path.startsWith(skillPath + '/')
            ? entry.path.slice(skillPath.length + 1)
            : entry.name;
          files.push({ path: relativePath, content });
        }
      } else if (entry.type === 'dir') {
        // Recurse into subdirectories (scripts/, references/, assets/)
        const subFiles = await this.downloadSkillFiles(source, entry.path, commitSha);
        for (const subFile of subFiles) {
          const relativePath = entry.path.startsWith(skillPath + '/')
            ? `${entry.path.slice(skillPath.length + 1)}/${subFile.path}`
            : `${entry.name}/${subFile.path}`;
          files.push({ path: relativePath, content: subFile.content });
        }
      }
    }

    return files;
  }

  /**
   * Create a tar.gz archive from skill files.
   */
  private async createArchive(skillName: string, files: SkillFileEntry[]): Promise<Buffer> {
    // Dynamic import of tar (already a dependency of shared package)
    const tar = await import('tar');
    const { writeFileSync, mkdirSync, rmSync } = await import('fs');
    const { join } = await import('path');
    const { tmpdir } = await import('os');
    const { randomUUID } = await import('crypto');

    // Create a temp directory with the skill files
    const tempBase = join(tmpdir(), `skill-archive-${randomUUID()}`);
    const tempDir = join(tempBase, skillName);
    mkdirSync(tempDir, { recursive: true });

    try {
      // Write files to temp directory
      for (const file of files) {
        const filePath = join(tempDir, file.path);
        const fileDir = join(filePath, '..');
        mkdirSync(fileDir, { recursive: true });
        writeFileSync(filePath, file.content, 'utf-8');
      }

      // Create tar.gz
      const archivePath = join(tempBase, `${skillName}.tar.gz`);
      await tar.create(
        {
          gzip: true,
          file: archivePath,
          cwd: tempBase,
        },
        [skillName]
      );

      const { readFileSync } = await import('fs');
      return readFileSync(archivePath);
    } finally {
      // Clean up temp directory
      rmSync(tempBase, { recursive: true, force: true });
    }
  }
}
