// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Skill SKILL.md parser.
 *
 * Parses a SKILL.md file according to the Agent Skills Specification:
 * https://agentskills.io/specification
 *
 * Uses `gray-matter` to extract YAML frontmatter and markdown body.
 */

import matter from 'gray-matter';

/** Parsed frontmatter fields from a SKILL.md file */
export interface SkillFrontmatter {
  name: string;                        // Required: 1-64 chars, lowercase alphanumeric + hyphens
  description: string;                 // Required: 1-1024 chars
  license?: string;                    // Optional
  compatibility?: string;             // Optional: 1-500 chars
  allowedTools?: string;              // Optional: space-delimited tool list
  metadata?: Record<string, string>;  // Optional: arbitrary key-value
}

/** Result of parsing a SKILL.md file */
export interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  content: string;                     // Markdown body after frontmatter
  raw: string;                         // Original raw SKILL.md content
}

/**
 * Parse a SKILL.md file content into structured frontmatter and body.
 *
 * @param rawContent - The full text of the SKILL.md file
 * @returns ParsedSkill with frontmatter fields and markdown body
 * @throws Error if required frontmatter fields are missing or invalid types
 */
export function parseSkillMd(rawContent: string): ParsedSkill {
  const { data, content } = matter(rawContent);

  if (!data.name || typeof data.name !== 'string') {
    throw new Error('SKILL.md missing required frontmatter field: name');
  }

  if (!data.description || typeof data.description !== 'string') {
    throw new Error('SKILL.md missing required frontmatter field: description');
  }

  const frontmatter: SkillFrontmatter = {
    name: data.name,
    description: data.description,
  };

  if (data.license !== undefined) {
    frontmatter.license = String(data.license);
  }

  if (data.compatibility !== undefined) {
    frontmatter.compatibility = String(data.compatibility);
  }

  // allowed-tools uses a hyphen in the spec, but we store as camelCase
  const allowedTools = data['allowed-tools'] ?? data.allowedTools;
  if (allowedTools !== undefined) {
    frontmatter.allowedTools = String(allowedTools);
  }

  if (data.metadata !== undefined && typeof data.metadata === 'object' && data.metadata !== null) {
    // Ensure all values are strings
    const metadata: Record<string, string> = {};
    for (const [key, value] of Object.entries(data.metadata)) {
      metadata[key] = String(value);
    }
    frontmatter.metadata = metadata;
  }

  return {
    frontmatter,
    content: content.trim(),
    raw: rawContent,
  };
}
