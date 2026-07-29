// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { SkillConfig, SkillRevisionDocument } from '@scope/core';

/**
 * Client for resolving skill revision refs via the Scope REST API.
 *
 * Used by queue processors at message-processing time to resolve
 * skill revision refs stored on RequestDocuments into SkillConfig
 * objects that can be passed to coding agent workers.
 */
export class SkillClient {
  private readonly apiUrl: string;

  constructor(apiUrl: string) {
    this.apiUrl = apiUrl.replace(/\/+$/, '');
  }

  /**
   * Resolve an array of skill revision refs to their configurations.
   * Fetches each revision from the API and maps to SkillConfig.
   *
   * @param refs - Skill revision refs (e.g. "vercel-labs/agent-skills/my-skill@a1b2c3d")
   * @throws Error if any ref cannot be resolved (404 or HTTP error)
   */
  async resolveSkills(refs: string[]): Promise<SkillConfig[]> {
    if (refs.length === 0) return [];

    const configs: SkillConfig[] = [];

    for (const ref of refs) {
      const url = `${this.apiUrl}/api/v1/skill-revisions/by-ref/${encodeURIComponent(ref)}`;
      const res = await fetch(url);

      if (res.status === 404) {
        throw new Error(`Skill revision '${ref}' not found via API`);
      }
      if (!res.ok) {
        throw new Error(`[SkillClient] GET ${url} failed: ${res.status} ${res.statusText}`);
      }

      const data = await res.json() as SkillRevisionDocument;
      configs.push({
        ref,
        name: data.name,
        description: data.description,
        content: data.content,
      });
    }

    return configs;
  }

  /**
   * Download a skill revision archive (tar.gz) through the API.
   *
   * The API proxies the download from blob storage, so the worker
   * does not need direct blob storage access.
   *
   * @param ref - Skill revision ref (e.g. "vercel-labs/agent-skills/my-skill@a1b2c3d")
   * @returns Buffer containing the tar.gz archive
   * @throws Error if the archive cannot be downloaded
   */
  async downloadSkillArchive(ref: string): Promise<Buffer> {
    const url = `${this.apiUrl}/api/v1/skill-revisions/by-ref/${encodeURIComponent(ref)}/archive`;
    const res = await fetch(url);

    if (res.status === 404) {
      throw new Error(`Skill archive for '${ref}' not found via API`);
    }
    if (!res.ok) {
      throw new Error(`[SkillClient] GET ${url} failed: ${res.status} ${res.statusText}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
