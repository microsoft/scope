// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { v5 as uuidv5 } from 'uuid';

/**
 * Namespace UUID derived from 'skill-revision.scope-mt.dev' using the RFC 4122 DNS namespace.
 * Used to generate deterministic UUIDv5 identifiers for skill revisions.
 */
export const SKILL_REVISION_NAMESPACE = uuidv5('skill-revision.scope-mt.dev', uuidv5.DNS);

/**
 * Build the human-readable skill revision ref string.
 *
 * Format: `{source}/{skillName}@{commitHash}`
 * Example: `vercel-labs/agent-skills/vercel-react-best-practices@a1b2c3d4e5f6`
 *
 * This ref is stored on RequestDocument.skillRevisions for clarity,
 * and used as input to computeSkillRevisionId() for the UUIDv5 _id.
 */
export function buildSkillRevisionRef(source: string, skillName: string, commitHash: string): string {
  return `${source}/${skillName}@${commitHash}`;
}

/**
 * Compute a deterministic UUIDv5 for a skill revision from its ref string.
 *
 * @param ref - The skill revision ref (e.g. "vercel-labs/agent-skills/vercel-react-best-practices@a1b2c3d")
 * @returns A deterministic UUID string
 */
export function computeSkillRevisionId(ref: string): string {
  return uuidv5(ref, SKILL_REVISION_NAMESPACE);
}
