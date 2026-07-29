// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SkillClient } from './skill-client.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('SkillClient', () => {
  let client: SkillClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new SkillClient('http://localhost:3100');
  });

  it('returns empty array for no refs', async () => {
    const result = await client.resolveSkills([]);
    expect(result).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('resolves a single ref to SkillConfig', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        _id: 'test-uuid',
        ref: 'owner/repo/skill@abc1234',
        source: 'owner/repo',
        skillName: 'skill',
        commitHash: 'abc1234',
        name: 'Test Skill',
        description: 'A test skill',
        content: '# SKILL.md content',
        resolvedAt: new Date().toISOString(),
      }),
    });

    const result = await client.resolveSkills(['owner/repo/skill@abc1234']);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      ref: 'owner/repo/skill@abc1234',
      name: 'Test Skill',
      description: 'A test skill',
      content: '# SKILL.md content',
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3100/api/v1/skill-revisions/by-ref/owner%2Frepo%2Fskill%40abc1234'
    );
  });

  it('resolves multiple refs', async () => {
    for (const name of ['Skill A', 'Skill B']) {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          _id: `id-${name}`,
          ref: `ref-${name}`,
          source: 'src',
          skillName: name,
          commitHash: 'abc',
          name,
          content: `content-${name}`,
          resolvedAt: new Date().toISOString(),
        }),
      });
    }

    const result = await client.resolveSkills(['ref-A', 'ref-B']);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('Skill A');
    expect(result[1].name).toBe('Skill B');
  });

  it('throws on 404 (ref not found)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
    });

    await expect(client.resolveSkills(['missing/ref@abc']))
      .rejects.toThrow("Skill revision 'missing/ref@abc' not found via API");
  });

  it('throws on HTTP error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    await expect(client.resolveSkills(['some/ref@abc']))
      .rejects.toThrow('failed: 500 Internal Server Error');
  });

  it('strips trailing slashes from API URL', async () => {
    const c = new SkillClient('http://localhost:3100///');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        _id: 'id', ref: 'r', source: 's', skillName: 'sk',
        commitHash: 'h', name: 'n', content: 'c', resolvedAt: new Date().toISOString(),
      }),
    });

    await c.resolveSkills(['ref']);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('http://localhost:3100/api/v1/')
    );
  });

  describe('downloadSkillArchive', () => {
    it('downloads archive and returns Buffer', async () => {
      const archiveData = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]); // gzip magic bytes
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => archiveData.buffer,
      });

      const result = await client.downloadSkillArchive('owner/repo/skill@abc1234');

      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result.length).toBe(4);
      expect(result[0]).toBe(0x1f);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3100/api/v1/skill-revisions/by-ref/owner%2Frepo%2Fskill%40abc1234/archive'
      );
    });

    it('throws on 404', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      await expect(client.downloadSkillArchive('missing/ref@abc'))
        .rejects.toThrow("Skill archive for 'missing/ref@abc' not found via API");
    });

    it('throws on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(client.downloadSkillArchive('some/ref@abc'))
        .rejects.toThrow('failed: 500 Internal Server Error');
    });
  });
});
