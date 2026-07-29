// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractSkillsToWorkspace } from './skill-extractor.js';
import type { SkillConfig } from '@scope/core';
import { SkillClient } from './skill-client.js';
import { mkdirSync, existsSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

// Create a real tar.gz archive in memory for integration-style tests
function createTestArchive(skillName: string, files: Record<string, string>): Buffer {
  const tmpDir = mkdirSync(join(tmpdir(), `skill-extractor-test-${Date.now()}`), { recursive: true }) as unknown as string
    || join(tmpdir(), `skill-extractor-test-${Date.now()}`);
  const skillDir = join(tmpDir, skillName);
  mkdirSync(skillDir, { recursive: true });

  for (const [name, content] of Object.entries(files)) {
    const filePath = join(skillDir, name);
    const dir = filePath.substring(0, filePath.lastIndexOf('/'));
    if (dir !== skillDir) {
      mkdirSync(dir, { recursive: true });
    }
    require('fs').writeFileSync(filePath, content);
  }

  // Create tar.gz
  const archivePath = join(tmpDir, `${skillName}.tar.gz`);
  execSync(`tar czf "${archivePath}" -C "${tmpDir}" "${skillName}"`, { stdio: 'pipe' });
  const buffer = readFileSync(archivePath);

  // Cleanup tmp dir
  rmSync(tmpDir, { recursive: true, force: true });

  return buffer;
}

describe('extractSkillsToWorkspace', () => {
  let workspacePath: string;
  let mockClient: SkillClient;

  beforeEach(() => {
    workspacePath = join(tmpdir(), `skill-extract-ws-${Date.now()}`);
    mkdirSync(workspacePath, { recursive: true });
    mockClient = new SkillClient('http://localhost:3100');
  });

  afterEach(() => {
    rmSync(workspacePath, { recursive: true, force: true });
  });

  it('returns empty array when no refs provided', async () => {
    const result = await extractSkillsToWorkspace({
      refs: [],
      skillConfigs: [],
      skillClient: mockClient,
      workspacePath,
    });
    expect(result).toEqual([]);
  });

  it('extracts skill archive to .agents/skills/<name>/', async () => {
    const archive = createTestArchive('my-skill', {
      'SKILL.md': '---\nname: my-skill\n---\n# My Skill\nDo the thing.',
    });

    vi.spyOn(mockClient, 'downloadSkillArchive').mockResolvedValueOnce(archive);

    const configs: SkillConfig[] = [
      { ref: 'owner/repo/my-skill@abc1234', name: 'my-skill', description: 'Test', content: 'full content' },
    ];

    const result = await extractSkillsToWorkspace({
      refs: ['owner/repo/my-skill@abc1234'],
      skillConfigs: configs,
      skillClient: mockClient,
      workspacePath,
    });

    expect(result).toContain('.agents/skills/my-skill');
    const skillMd = readFileSync(join(workspacePath, '.agents/skills/my-skill/SKILL.md'), 'utf-8');
    expect(skillMd).toContain('# My Skill');
  });

  it('also extracts to agent-specific directory for copilot', async () => {
    const archive = createTestArchive('copilot-skill', {
      'SKILL.md': '# Copilot Skill',
    });

    vi.spyOn(mockClient, 'downloadSkillArchive').mockResolvedValueOnce(archive);

    const configs: SkillConfig[] = [
      { ref: 'ref@abc', name: 'copilot-skill', description: 'Test', content: 'c' },
    ];

    const result = await extractSkillsToWorkspace({
      refs: ['ref@abc'],
      skillConfigs: configs,
      skillClient: mockClient,
      workspacePath,
      agentType: 'copilot',
    });

    expect(result).toContain('.agents/skills/copilot-skill');
    expect(result).toContain('.copilot/skills/copilot-skill');
    expect(existsSync(join(workspacePath, '.copilot/skills/copilot-skill/SKILL.md'))).toBe(true);
  });

  it('also extracts to agent-specific directory for claude-code', async () => {
    const archive = createTestArchive('claude-skill', {
      'SKILL.md': '# Claude Skill',
    });

    vi.spyOn(mockClient, 'downloadSkillArchive').mockResolvedValueOnce(archive);

    const configs: SkillConfig[] = [
      { ref: 'ref@abc', name: 'claude-skill', description: 'Test', content: 'c' },
    ];

    const result = await extractSkillsToWorkspace({
      refs: ['ref@abc'],
      skillConfigs: configs,
      skillClient: mockClient,
      workspacePath,
      agentType: 'claude-code',
    });

    expect(result).toContain('.agents/skills/claude-skill');
    expect(result).toContain('.claude/skills/claude-skill');
    expect(existsSync(join(workspacePath, '.claude/skills/claude-skill/SKILL.md'))).toBe(true);
  });

  it('continues on error and extracts remaining skills', async () => {
    const archive = createTestArchive('good-skill', {
      'SKILL.md': '# Good Skill',
    });

    const spy = vi.spyOn(mockClient, 'downloadSkillArchive');
    spy.mockRejectedValueOnce(new Error('Network error'));
    spy.mockResolvedValueOnce(archive);

    const configs: SkillConfig[] = [
      { ref: 'ref-bad@abc', name: 'bad-skill', description: 'Will fail', content: 'c' },
      { ref: 'ref-good@abc', name: 'good-skill', description: 'Will succeed', content: 'c' },
    ];

    const logMessages: string[] = [];
    const result = await extractSkillsToWorkspace({
      refs: ['ref-bad@abc', 'ref-good@abc'],
      skillConfigs: configs,
      skillClient: mockClient,
      workspacePath,
      log: (msg) => { logMessages.push(msg); },
    });

    // Only good-skill should be installed
    expect(result).toContain('.agents/skills/good-skill');
    expect(result).not.toContain('.agents/skills/bad-skill');
    // Error should be logged
    expect(logMessages.some(m => m.includes('Failed to extract skill "bad-skill"'))).toBe(true);
  });

  it('cleans up temp archive file after extraction', async () => {
    const archive = createTestArchive('clean-skill', {
      'SKILL.md': '# Clean',
    });

    vi.spyOn(mockClient, 'downloadSkillArchive').mockResolvedValueOnce(archive);

    const configs: SkillConfig[] = [
      { ref: 'ref@abc', name: 'clean-skill', description: 'Test', content: 'c' },
    ];

    await extractSkillsToWorkspace({
      refs: ['ref@abc'],
      skillConfigs: configs,
      skillClient: mockClient,
      workspacePath,
    });

    // Temp archive should be cleaned up
    const skillDir = join(workspacePath, '.agents/skills/clean-skill');
    expect(existsSync(join(skillDir, '.tmp-archive.tar.gz'))).toBe(false);
    // But SKILL.md should exist
    expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true);
  });
});
