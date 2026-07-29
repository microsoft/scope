// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Skill SKILL.md frontmatter validator.
 *
 * Validates parsed frontmatter fields according to the Agent Skills Specification:
 * https://agentskills.io/specification
 */

import type { SkillFrontmatter } from './skill-parser.js';

/** A single validation error */
export interface SkillValidationError {
  field: string;
  message: string;
}

/** A single validation warning (non-blocking) */
export interface SkillValidationWarning {
  field: string;
  message: string;
}

/** Result of validating SKILL.md frontmatter */
export interface SkillValidationResult {
  valid: boolean;
  errors: SkillValidationError[];
  warnings: SkillValidationWarning[];
}

/**
 * Regex for the `name` field per spec:
 * - Lowercase alphanumeric characters and hyphens only
 * - Must not start or end with a hyphen
 * - Must not contain consecutive hyphens
 * - 1-64 characters
 */
const NAME_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Validate SKILL.md frontmatter fields per the Agent Skills Specification.
 *
 * @param frontmatter - Parsed frontmatter to validate
 * @param dirName - Parent directory name (spec requires name to match it)
 * @returns Validation result with any errors
 */
export function validateSkillFrontmatter(
  frontmatter: SkillFrontmatter,
  dirName?: string
): SkillValidationResult {
  const errors: SkillValidationError[] = [];
  const warnings: SkillValidationWarning[] = [];

  // name: required, 1-64 chars, lowercase + hyphens, no leading/trailing/consecutive hyphens
  if (!frontmatter.name) {
    errors.push({ field: 'name', message: 'name is required' });
  } else {
    if (frontmatter.name.length > 64) {
      errors.push({ field: 'name', message: `name must be at most 64 characters (got ${frontmatter.name.length})` });
    }
    if (!NAME_REGEX.test(frontmatter.name)) {
      errors.push({ field: 'name', message: 'name must contain only lowercase alphanumeric characters and hyphens, must not start or end with a hyphen' });
    }
    if (frontmatter.name.includes('--')) {
      errors.push({ field: 'name', message: 'name must not contain consecutive hyphens (--)' });
    }
    if (dirName && frontmatter.name !== dirName) {
      warnings.push({ field: 'name', message: `name "${frontmatter.name}" does not match parent directory name "${dirName}" (spec recommends they match)` });
    }
  }

  // description: required, 1-1024 chars
  if (!frontmatter.description) {
    errors.push({ field: 'description', message: 'description is required' });
  } else if (frontmatter.description.length > 1024) {
    errors.push({ field: 'description', message: `description must be at most 1024 characters (got ${frontmatter.description.length})` });
  }

  // compatibility: optional, 1-500 chars
  if (frontmatter.compatibility !== undefined && frontmatter.compatibility.length > 500) {
    errors.push({ field: 'compatibility', message: `compatibility must be at most 500 characters (got ${frontmatter.compatibility.length})` });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
