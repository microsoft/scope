// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const SHORT_COMMIT_HASH_LENGTH = 7;

export interface ParsedSkillSpec {
  slug: string;
  commitHash?: string;
}

interface RunSkills {
  skills?: readonly string[] | null;
  skillRevisions?: readonly string[] | null;
}

export function parseSkillSpec(spec: string): ParsedSkillSpec {
  const at = spec.lastIndexOf("@");
  if (at > 0) {
    return {
      slug: spec.substring(0, at),
      commitHash: spec.substring(at + 1) || undefined,
    };
  }
  return { slug: spec };
}

/** Use immutable revision refs when available, falling back to legacy skill slugs. */
export function getRunSkillReferences(run: RunSkills): string[] {
  const references = run.skillRevisions?.length
    ? run.skillRevisions
    : (run.skills ?? []);
  return Array.from(new Set(references));
}

export function shortCommitHash(commitHash: string): string {
  return commitHash.substring(0, SHORT_COMMIT_HASH_LENGTH);
}
