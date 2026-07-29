// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { SkillConfig } from '@scope/core';

/**
 * Format a lightweight discovery prompt listing available skills.
 *
 * @deprecated Agents (Copilot, Claude Code) automatically discover skills from
 * `.agents/skills/`, `.copilot/skills/`, `.claude/skills/` on the filesystem.
 * No prompt injection is needed — the skill extractor places files on disk and
 * agents discover them at startup. This function is kept for backward compatibility.
 */
export function formatSkillsDiscoveryPrompt(
  skills: SkillConfig[],
  basePath: string = '.agents/skills'
): string {
  if (!skills || skills.length === 0) {
    return '';
  }

  const skillBlocks = skills
    .map((s) => {
      const location = `${basePath}/${s.name}`;
      return `<skill name="${escapeXmlAttr(s.name)}" location="${escapeXmlAttr(location)}">\n${s.description.trim()}\n</skill>`;
    })
    .join('\n');

  return `<available_skills>\n${skillBlocks}\n</available_skills>`;
}

/**
 * Prepend skill discovery context to a task message.
 *
 * @deprecated Agents discover skills from the filesystem automatically.
 * No prompt injection is needed. Kept for backward compatibility.
 */
export function prependSkillsToMessage(
  message: string,
  skills?: SkillConfig[],
  basePath?: string
): string {
  if (!skills || skills.length === 0) {
    return message;
  }

  const preamble = formatSkillsDiscoveryPrompt(skills, basePath);
  return `${preamble}\n\n${message}`;
}

// --- Legacy functions (kept for backward compatibility) ---

/**
 * Format skill configs into a full-content prompt preamble.
 *
 * @deprecated Use `formatSkillsDiscoveryPrompt()` instead — full content is now
 * delivered via the filesystem, not prompt injection.
 */
export function formatSkillsPrompt(skills: SkillConfig[]): string {
  if (!skills || skills.length === 0) {
    return '';
  }

  const skillBlocks = skills
    .map(
      (s) =>
        `<skill name="${escapeXmlAttr(s.name)}">\n${s.content.trim()}\n</skill>`
    )
    .join('\n');

  return `<skills>\n${skillBlocks}\n</skills>`;
}

/** Escape special characters in XML attribute values */
function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
