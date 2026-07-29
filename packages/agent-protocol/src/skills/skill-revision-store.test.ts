// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SkillRevisionStore } from './skill-revision-store.js';
import { computeSkillRevisionId } from './skill-revision-id.js';
import type { SkillRevisionDocument } from '@scope/core';

/** Build a full SkillRevisionDocument with required defaults */
function makeRevDoc(overrides: Partial<SkillRevisionDocument> & Pick<SkillRevisionDocument, '_id' | 'ref' | 'source' | 'skillName' | 'commitHash' | 'name' | 'content'>): SkillRevisionDocument {
  return {
    skillPath: `skills/${overrides.skillName}`,
    commitTimestamp: new Date(),
    description: 'test description',
    archiveUrl: 'https://blob.test/archive.tar.gz',
    resolvedAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}

/** Create a mock MongoDB collection with chainable find/sort/limit/toArray */
function makeMockCollection() {
  const store = new Map<string, SkillRevisionDocument>();
  const toArrayResult: SkillRevisionDocument[] = [];

  const mockChain = {
    sort: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    toArray: vi.fn().mockImplementation(() => Promise.resolve(toArrayResult)),
  };

  return {
    findOne: vi.fn().mockImplementation(async (filter: any) => {
      if (filter._id) return store.get(filter._id) ?? null;
      return null;
    }),
    find: vi.fn().mockReturnValue(mockChain),
    insertOne: vi.fn().mockImplementation(async (doc: any) => {
      store.set(doc._id, doc);
      return { insertedId: doc._id };
    }),
    _store: store,
    _chain: mockChain,
    _toArrayResult: toArrayResult,
  };
}

describe('SkillRevisionStore', () => {
  let mockCol: ReturnType<typeof makeMockCollection>;
  let revStore: SkillRevisionStore;

  beforeEach(() => {
    mockCol = makeMockCollection();
    revStore = new SkillRevisionStore(mockCol as any);
  });

  describe('get', () => {
    it('returns null for non-existent ID', async () => {
      const result = await revStore.get('non-existent');
      expect(result).toBeNull();
    });

    it('returns document when found', async () => {
      const doc = makeRevDoc({
        _id: 'test-id',
        ref: 'owner/repo/skill@abc123',
        source: 'owner/repo',
        skillName: 'skill',
        commitHash: 'abc123',
        name: 'Test',
        content: '# SKILL.md',
      });
      mockCol._store.set('test-id', doc);
      const result = await revStore.get('test-id');
      expect(result).toEqual(doc);
    });
  });

  describe('getByRef', () => {
    it('computes ID from ref and looks up', async () => {
      const ref = 'owner/repo/skill@abc123';
      const id = computeSkillRevisionId(ref);
      const doc = makeRevDoc({
        _id: id,
        ref,
        source: 'owner/repo',
        skillName: 'skill',
        commitHash: 'abc123',
        name: 'Test',
        content: '# content',
      });
      mockCol._store.set(id, doc);
      const result = await revStore.getByRef(ref);
      expect(result).toEqual(doc);
    });
  });

  describe('findOrCreate', () => {
    const inputDoc = {
      ref: 'owner/repo/skill@abc123',
      source: 'owner/repo',
      skillName: 'skill',
      skillPath: 'skills/skill',
      commitHash: 'abc123',
      commitTimestamp: new Date(),
      name: 'Test Skill',
      description: 'test',
      content: '# content',
      archiveUrl: 'https://blob.test/archive.tar.gz',
      resolvedAt: new Date(),
    };

    it('creates a new document when it does not exist', async () => {
      const result = await revStore.findOrCreate(inputDoc);
      const expectedId = computeSkillRevisionId(inputDoc.ref);
      expect(result._id).toBe(expectedId);
      expect(result.name).toBe('Test Skill');
      expect(result.content).toBe('# content');
      expect(mockCol.insertOne).toHaveBeenCalledOnce();
    });

    it('returns existing document without inserting', async () => {
      const id = computeSkillRevisionId(inputDoc.ref);
      const existing = makeRevDoc({ ...inputDoc, _id: id });
      mockCol._store.set(id, existing);

      const result = await revStore.findOrCreate(inputDoc);
      expect(result).toEqual(existing);
      expect(mockCol.insertOne).not.toHaveBeenCalled();
    });

    it('is idempotent — same ref returns same ID', async () => {
      const r1 = await revStore.findOrCreate(inputDoc);
      // Simulate that the doc is now in the store (insertOne populated it)
      const r2 = await revStore.findOrCreate(inputDoc);
      expect(r1._id).toBe(r2._id);
    });
  });

  describe('listBySkill', () => {
    it('calls find with source and skillName', async () => {
      await revStore.listBySkill('owner/repo', 'my-skill');
      expect(mockCol.find).toHaveBeenCalledWith({ source: 'owner/repo', skillName: 'my-skill' });
      expect(mockCol._chain.sort).toHaveBeenCalledWith({ resolvedAt: -1 });
      expect(mockCol._chain.limit).toHaveBeenCalledWith(20);
    });

    it('respects custom limit', async () => {
      await revStore.listBySkill('a', 'b', { limit: 5 });
      expect(mockCol._chain.limit).toHaveBeenCalledWith(5);
    });
  });

  describe('getByRefs', () => {
    it('returns empty array for empty refs', async () => {
      const result = await revStore.getByRefs([]);
      expect(result).toEqual([]);
      expect(mockCol.find).not.toHaveBeenCalled();
    });

    it('queries by computed IDs', async () => {
      const refs = ['owner/repo/s1@abc', 'owner/repo/s2@def'];
      const ids = refs.map(computeSkillRevisionId);

      await revStore.getByRefs(refs);
      expect(mockCol.find).toHaveBeenCalledWith({ _id: { $in: ids } });
    });
  });
});
