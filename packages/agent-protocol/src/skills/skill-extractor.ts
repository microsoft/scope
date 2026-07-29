// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Skill Extractor — downloads skill archives via the API and extracts them
 * to the workspace filesystem for agent discovery.
 *
 * Per the Agent Skills specification (https://agentskills.io/specification),
 * agents discover skills via filesystem directories:
 *   - `.agents/skills/<name>/SKILL.md`   (universal)
 *   - `.claude/skills/<name>/SKILL.md`   (Claude Code)
 *   - `.copilot/skills/<name>/SKILL.md`  (Copilot)
 *
 * Instead of injecting skill content into the prompt (which wastes tokens and
 * bypasses progressive disclosure), this module places the files on disk where
 * the agent will naturally discover them at startup.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { SkillClient } from './skill-client.js';
import type { SkillConfig } from '@scope/core';

/** Directories where extracted skills are placed, per agent convention. */
const SKILL_INSTALL_DIRS = [
  '.agents/skills',   // Universal (Agent Skills spec)
];

/**
 * Additional per-agent directories. Claude Code and Copilot scan their own
 * well-known paths in addition to `.agents/skills/`.
 */
const AGENT_SPECIFIC_DIRS: Record<string, string[]> = {
  'claude-code': ['.claude/skills'],
  'copilot': ['.copilot/skills'],
};

export interface ExtractSkillsOptions {
  /** Skill revision refs to download + extract */
  refs: string[];
  /** Resolved SkillConfig objects (for name mapping) */
  skillConfigs: SkillConfig[];
  /** SkillClient instance (pre-configured with API URL) */
  skillClient: SkillClient;
  /** Workspace root directory (e.g. "/workspace") */
  workspacePath: string;
  /** Optional: agent type key for agent-specific directories */
  agentType?: string;
  /** Optional: async log function */
  log?: (msg: string) => Promise<void> | void;
}

/**
 * Download skill archives from the API and extract to workspace directories.
 *
 * For each skill:
 * 1. Downloads the tar.gz archive through the API (SkillClient.downloadSkillArchive)
 * 2. Extracts to `.agents/skills/<skillName>/` under the workspace root
 * 3. Optionally also extracts to agent-specific directories (e.g. `.claude/skills/<skillName>/`)
 *
 * @returns Array of installed skill directory paths (relative to workspace)
 */
export async function extractSkillsToWorkspace(options: ExtractSkillsOptions): Promise<string[]> {
  const { refs, skillConfigs, skillClient, workspacePath, agentType, log } = options;

  if (refs.length === 0 || skillConfigs.length === 0) {
    return [];
  }

  const installedPaths: string[] = [];

  // Build target directories list
  const targetDirs = [...SKILL_INSTALL_DIRS];
  if (agentType && AGENT_SPECIFIC_DIRS[agentType]) {
    targetDirs.push(...AGENT_SPECIFIC_DIRS[agentType]);
  }

  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i];
    const config = skillConfigs[i];
    if (!config) continue;

    try {
      await log?.(`Downloading archive for skill "${config.name}" (ref: ${ref})`);
      const archiveBuffer = await skillClient.downloadSkillArchive(ref);

      // Extract to each target directory
      for (const dir of targetDirs) {
        const skillDir = join(workspacePath, dir, config.name);
        mkdirSync(skillDir, { recursive: true });

        // Write tar.gz to a temp file in the skill directory, extract, then clean up.
        // The archive structure is `<skillName>/...`, so we strip the first component.
        const tmpArchive = join(skillDir, '.tmp-archive.tar.gz');
        writeFileSync(tmpArchive, archiveBuffer);

        try {
          execSync(`tar xzf "${tmpArchive}" --strip-components=1 -C "${skillDir}"`, {
            stdio: 'pipe',
          });
        } finally {
          // Clean up temp archive
          try {
            execSync(`rm -f "${tmpArchive}"`, { stdio: 'pipe' });
          } catch {
            // ignore cleanup failures
          }
        }

        const relPath = `${dir}/${config.name}`;
        installedPaths.push(relPath);
        await log?.(`Extracted skill "${config.name}" to ${relPath}`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await log?.(`Failed to extract skill "${config.name}" (ref: ${ref}): ${msg}`);
      // Continue with remaining skills — don't fail the whole batch
    }
  }

  return installedPaths;
}
