// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from 'vitest';
import { validateSkillFrontmatter } from './skill-validator.js';
import type { SkillFrontmatter } from './skill-parser.js';

describe('validateSkillFrontmatter', () => {
  const validFrontmatter: SkillFrontmatter = {
    name: 'my-skill',
    description: 'A valid skill description',
  };

  it('should pass for valid frontmatter', () => {
    const result = validateSkillFrontmatter(validFrontmatter);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should pass when name matches directory name', () => {
    const result = validateSkillFrontmatter(validFrontmatter, 'my-skill');
    expect(result.valid).toBe(true);
  });

  it('should pass with warning when name does not match directory name', () => {
    const result = validateSkillFrontmatter(validFrontmatter, 'wrong-name');
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ field: 'name', message: expect.stringContaining('does not match parent directory name') })
    );
  });

  it('should have empty warnings when name matches directory name', () => {
    const result = validateSkillFrontmatter(validFrontmatter, 'my-skill');
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('should have empty warnings when no dirName is provided', () => {
    const result = validateSkillFrontmatter(validFrontmatter);
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('should fail for empty name', () => {
    const result = validateSkillFrontmatter({ ...validFrontmatter, name: '' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: 'name' })
    );
  });

  it('should fail for name with uppercase', () => {
    const result = validateSkillFrontmatter({ ...validFrontmatter, name: 'My-Skill' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: 'name', message: expect.stringContaining('lowercase') })
    );
  });

  it('should fail for name starting with hyphen', () => {
    const result = validateSkillFrontmatter({ ...validFrontmatter, name: '-my-skill' });
    expect(result.valid).toBe(false);
  });

  it('should fail for name ending with hyphen', () => {
    const result = validateSkillFrontmatter({ ...validFrontmatter, name: 'my-skill-' });
    expect(result.valid).toBe(false);
  });

  it('should fail for name with consecutive hyphens', () => {
    const result = validateSkillFrontmatter({ ...validFrontmatter, name: 'my--skill' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: 'name', message: expect.stringContaining('consecutive hyphens') })
    );
  });

  it('should fail for name longer than 64 characters', () => {
    const result = validateSkillFrontmatter({ ...validFrontmatter, name: 'a'.repeat(65) });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: 'name', message: expect.stringContaining('at most 64') })
    );
  });

  it('should accept single-character name', () => {
    const result = validateSkillFrontmatter({ ...validFrontmatter, name: 'a' });
    expect(result.valid).toBe(true);
  });

  it('should fail for empty description', () => {
    const result = validateSkillFrontmatter({ ...validFrontmatter, description: '' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: 'description' })
    );
  });

  it('should fail for description longer than 1024 characters', () => {
    const result = validateSkillFrontmatter({ ...validFrontmatter, description: 'x'.repeat(1025) });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: 'description', message: expect.stringContaining('at most 1024') })
    );
  });

  it('should fail for compatibility longer than 500 characters', () => {
    const result = validateSkillFrontmatter({ ...validFrontmatter, compatibility: 'x'.repeat(501) });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: 'compatibility', message: expect.stringContaining('at most 500') })
    );
  });

  it('should pass for valid compatibility', () => {
    const result = validateSkillFrontmatter({ ...validFrontmatter, compatibility: 'Requires git and docker' });
    expect(result.valid).toBe(true);
  });
});
