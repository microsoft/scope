// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// --- Skill types ---

/**
 * How a skill was added to the internal skill list.
 * - "skills-sh": imported from skills.sh search results
 * - "manual": added manually by entering source + skill name
 */
export type SkillOrigin = "skills-sh" | "manual";

/**
 * Skill reference document stored in MongoDB (`skills` collection).
 *
 * A mutable pointer to a skill in a GitHub repository.
 * The `_id` slug is `{source}/{skillName}` (e.g. "vercel-labs/agent-skills/vercel-react-best-practices").
 */
export interface SkillDocument {
  _id: string;                    // Slug: "{source}/{skillName}"
  source: string;                 // GitHub repo (e.g. "vercel-labs/agent-skills")
  skillName: string;              // Skill name within the repo (e.g. "vercel-react-best-practices")
  name: string;                   // Human-readable display name (from SKILL.md or user input)
  description?: string;           // From SKILL.md frontmatter or skills.sh
  origin: SkillOrigin;            // How the skill was added
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date;               // Soft-delete timestamp
}

/**
 * Skill revision document stored in MongoDB (`skill-revisions` collection).
 *
 * An **immutable** versioned snapshot of a skill, captured at run submission time.
 * Content-addressed: `_id` is `UUIDv5(ref)` where `ref` is `{source}/{skillName}@{commitHash}`.
 *
 * Follows the Agent Skills Specification: https://agentskills.io/specification
 */
export interface SkillRevisionDocument {
  _id: string;                    // UUIDv5 computed from `ref`
  ref: string;                    // Human-readable ref: "{source}/{skillName}@{commitHash}"
  source: string;                 // GitHub repo (e.g. "vercel-labs/agent-skills")
  skillName: string;              // Skill name (matches parent directory name per spec)
  skillPath: string;              // Path within repo (e.g. "skills/vercel-react-best-practices")
  commitHash: string;             // Latest commit touching the skill directory
  commitTimestamp: Date;          // That commit's timestamp

  // Spec frontmatter fields (https://agentskills.io/specification)
  name: string;                   // Required: 1-64 chars, lowercase alphanumeric + hyphens
  description: string;            // Required: 1-1024 chars
  license?: string;               // Optional: license name or reference
  compatibility?: string;         // Optional: 1-500 chars, environment requirements
  allowedTools?: string;          // Optional: space-delimited pre-approved tools (experimental)
  metadata?: Record<string, string>; // Optional: arbitrary key-value pairs

  // Content
  content: string;                // SKILL.md markdown body (after frontmatter)
  archiveUrl: string;             // Blob storage URL to the skill directory tar.gz

  // Housekeeping
  validationWarnings?: string[];    // Non-blocking validation warnings (e.g. name-dir mismatch)
  resolvedAt: Date;               // When the skill was fetched/resolved
  createdAt: Date;
}

/**
 * Resolved skill configuration passed to workers at runtime.
 * Contains the minimal information needed to download and install the skill.
 */
export interface SkillConfig {
  ref: string;                    // Revision ref (e.g. "owner/repo/skill@commitHash")
  name: string;
  description: string;
  content: string;                // SKILL.md markdown body
}

/**
 * Unified search result returned by the skills search endpoint.
 * Merges results from the internal DB and external registries (skills.sh).
 */
export interface SkillSearchResult {
  id: string;                     // Slug: "{source}/{skillName}"
  name: string;                   // Skill name
  source: string;                 // GitHub repo
  description?: string;
  internal: boolean;              // true if already in our DB
  installs?: number;              // Install count from skills.sh (external only)
}

/**
 * A skill discovered by enumerating the well-known directories of a GitHub repo.
 * Returned by the skill discovery endpoint to power the multi-skill import wizard.
 */
export interface SkillDiscoveryResult {
  skillName: string;              // Directory name (last path segment)
  skillPath: string;              // Full path within the repo
  name?: string;                  // Display name from SKILL.md frontmatter (best-effort)
  description?: string;           // Description from SKILL.md frontmatter (best-effort)
  // Library-status enrichment (set by the API route, not the resolver):
  existsInLibrary?: boolean;      // True if a SkillDocument with this source+skillName exists
  currentRevisionCommitSha?: string; // commitHash of the most recently stored SkillRevisionDocument
  latestUpstreamCommitSha?: string;  // commitSha of the latest commit touching skillPath upstream
  updateAvailable?: boolean;      // existsInLibrary && currentRevisionCommitSha !== latestUpstreamCommitSha
  lastImportedAt?: string;        // ISO timestamp of the most recent revision (if existsInLibrary)
}
