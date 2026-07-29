// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from 'vitest';
import { formatSkillsPrompt, formatSkillsDiscoveryPrompt, prependSkillsToMessage } from './skill-prompt.js';
import type { SkillConfig } from '@scope/core';

describe('formatSkillsPrompt (legacy full-content)', () => {
  it('returns empty string for no skills', () => {
    expect(formatSkillsPrompt([])).toBe('');
  });

  it('formats a single skill', () => {
    const skills: SkillConfig[] = [
      { ref: 'test@abc', name: 'my-skill', description: 'A test skill', content: 'Do the thing.\n\nWith details.' },
    ];
    const result = formatSkillsPrompt(skills);
    expect(result).toBe(
      '<skills>\n<skill name="my-skill">\nDo the thing.\n\nWith details.\n</skill>\n</skills>'
    );
  });

  it('formats multiple skills', () => {
    const skills: SkillConfig[] = [
      { ref: 'test@abc', name: 'skill-a', description: 'First', content: 'Content A' },
      { ref: 'test@abc', name: 'skill-b', description: 'Second', content: 'Content B' },
    ];
    const result = formatSkillsPrompt(skills);
    expect(result).toContain('<skill name="skill-a">');
    expect(result).toContain('<skill name="skill-b">');
    expect(result).toContain('Content A');
    expect(result).toContain('Content B');
    expect(result.startsWith('<skills>')).toBe(true);
    expect(result.endsWith('</skills>')).toBe(true);
  });

  it('escapes XML special characters in skill name', () => {
    const skills: SkillConfig[] = [
      { ref: 'test@abc', name: 'skill<"test">', description: 'test', content: 'Body' },
    ];
    const result = formatSkillsPrompt(skills);
    expect(result).toContain('name="skill&lt;&quot;test&quot;&gt;"');
  });

  it('trims content whitespace', () => {
    const skills: SkillConfig[] = [
      { ref: 'test@abc', name: 'trimmed', description: 'test', content: '  \n  Content here  \n  ' },
    ];
    const result = formatSkillsPrompt(skills);
    expect(result).toContain('Content here');
    expect(result).toMatch(/<skill name="trimmed">\nContent here\n<\/skill>/);
  });
});

describe('formatSkillsDiscoveryPrompt', () => {
  it('returns empty string for no skills', () => {
    expect(formatSkillsDiscoveryPrompt([])).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(formatSkillsDiscoveryPrompt(undefined as any)).toBe('');
  });

  it('formats a single skill with name, description, and location', () => {
    const skills: SkillConfig[] = [
      { ref: 'test@abc', name: 'azure-functions', description: 'Deploy Azure Functions', content: 'Full content here' },
    ];
    const result = formatSkillsDiscoveryPrompt(skills);
    expect(result).toBe(
      '<available_skills>\n' +
      '<skill name="azure-functions" location=".agents/skills/azure-functions">\n' +
      'Deploy Azure Functions\n' +
      '</skill>\n' +
      '</available_skills>'
    );
  });

  it('does NOT include full content in output', () => {
    const skills: SkillConfig[] = [
      { ref: 'test@abc', name: 'test', description: 'Short desc', content: 'This is a very long SKILL.md body that should not appear' },
    ];
    const result = formatSkillsDiscoveryPrompt(skills);
    expect(result).not.toContain('very long SKILL.md body');
    expect(result).toContain('Short desc');
  });

  it('uses custom basePath', () => {
    const skills: SkillConfig[] = [
      { ref: 'test@abc', name: 'my-skill', description: 'desc', content: 'c' },
    ];
    const result = formatSkillsDiscoveryPrompt(skills, '.claude/skills');
    expect(result).toContain('location=".claude/skills/my-skill"');
  });

  it('formats multiple skills', () => {
    const skills: SkillConfig[] = [
      { ref: 'test@abc', name: 'skill-a', description: 'First skill', content: 'c' },
      { ref: 'test@abc', name: 'skill-b', description: 'Second skill', content: 'c' },
    ];
    const result = formatSkillsDiscoveryPrompt(skills);
    expect(result).toContain('name="skill-a"');
    expect(result).toContain('name="skill-b"');
    expect(result).toContain('First skill');
    expect(result).toContain('Second skill');
    expect(result.startsWith('<available_skills>')).toBe(true);
    expect(result.endsWith('</available_skills>')).toBe(true);
  });

  it('escapes special characters in name and location', () => {
    const skills: SkillConfig[] = [
      { ref: 'test@abc', name: 'skill<"x">', description: 'desc', content: 'c' },
    ];
    const result = formatSkillsDiscoveryPrompt(skills);
    expect(result).toContain('name="skill&lt;&quot;x&quot;&gt;"');
  });
});

describe('prependSkillsToMessage', () => {
  it('returns message unchanged when no skills', () => {
    expect(prependSkillsToMessage('Hello world')).toBe('Hello world');
    expect(prependSkillsToMessage('Hello world', [])).toBe('Hello world');
    expect(prependSkillsToMessage('Hello world', undefined)).toBe('Hello world');
  });

  it('prepends discovery prompt to message', () => {
    const skills: SkillConfig[] = [
      { ref: 'test@abc', name: 'react-best-practices', description: 'React tips', content: 'Use hooks.' },
    ];
    const result = prependSkillsToMessage('Build a todo app', skills);
    expect(result).toMatch(/^<available_skills>/);
    expect(result).toContain('React tips');
    expect(result).not.toContain('Use hooks.');  // Full content should NOT be in prompt
    expect(result).toContain('Build a todo app');
    // Discovery block should come before the message
    const blockEnd = result.indexOf('</available_skills>');
    const messageStart = result.indexOf('Build a todo app');
    expect(blockEnd).toBeLessThan(messageStart);
  });

  it('separates discovery preamble from message with double newline', () => {
    const skills: SkillConfig[] = [
      { ref: 'test@abc', name: 'test', description: 'desc', content: 'Content' },
    ];
    const result = prependSkillsToMessage('Task', skills);
    expect(result).toContain('</available_skills>\n\nTask');
  });

  it('accepts custom basePath', () => {
    const skills: SkillConfig[] = [
      { ref: 'test@abc', name: 'test', description: 'desc', content: 'c' },
    ];
    const result = prependSkillsToMessage('Task', skills, '.copilot/skills');
    expect(result).toContain('location=".copilot/skills/test"');
  });
});
