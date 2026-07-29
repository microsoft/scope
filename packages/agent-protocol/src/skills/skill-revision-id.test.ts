// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from 'vitest';
import { computeSkillRevisionId, buildSkillRevisionRef, SKILL_REVISION_NAMESPACE } from './skill-revision-id.js';

describe('buildSkillRevisionRef', () => {
  it('should build ref in format source/skillName@commitHash', () => {
    const ref = buildSkillRevisionRef('vercel-labs/agent-skills', 'vercel-react-best-practices', 'a1b2c3d');
    expect(ref).toBe('vercel-labs/agent-skills/vercel-react-best-practices@a1b2c3d');
  });

  it('should handle different sources and skill names', () => {
    const ref = buildSkillRevisionRef('anthropics/skills', 'frontend-design', 'deadbeef');
    expect(ref).toBe('anthropics/skills/frontend-design@deadbeef');
  });
});

describe('computeSkillRevisionId', () => {
  it('should return a valid UUID string', () => {
    const id = computeSkillRevisionId('vercel-labs/agent-skills/my-skill@abc123');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('should be deterministic — same input always gives same output', () => {
    const ref = 'vercel-labs/agent-skills/my-skill@abc123';
    const id1 = computeSkillRevisionId(ref);
    const id2 = computeSkillRevisionId(ref);
    expect(id1).toBe(id2);
  });

  it('should produce different IDs for different refs', () => {
    const id1 = computeSkillRevisionId('vercel-labs/agent-skills/my-skill@abc123');
    const id2 = computeSkillRevisionId('vercel-labs/agent-skills/my-skill@def456');
    expect(id1).not.toBe(id2);
  });

  it('should produce different IDs for different skill names', () => {
    const id1 = computeSkillRevisionId('vercel-labs/agent-skills/skill-a@abc123');
    const id2 = computeSkillRevisionId('vercel-labs/agent-skills/skill-b@abc123');
    expect(id1).not.toBe(id2);
  });

  it('should produce a UUIDv5 (version 5 indicator)', () => {
    const id = computeSkillRevisionId('any/ref@hash');
    // UUIDv5 has version nibble '5' at position 14
    expect(id[14]).toBe('5');
  });

  it('should export a valid namespace UUID', () => {
    expect(SKILL_REVISION_NAMESPACE).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
