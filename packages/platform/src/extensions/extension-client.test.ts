// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExtensionClient } from './extension-client.js';
import { parseExtensionSpec } from '@scope/core';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('parseExtensionSpec', () => {
  it('parses id without version', () => {
    expect(parseExtensionSpec('ms-python.python')).toEqual({ id: 'ms-python.python' });
  });

  it('parses id@version', () => {
    expect(parseExtensionSpec('ms-python.python@2024.22.1')).toEqual({
      id: 'ms-python.python',
      version: '2024.22.1',
    });
  });

  it('handles @ in publisher name (uses last @)', () => {
    expect(parseExtensionSpec('some.ext@1.0.0')).toEqual({
      id: 'some.ext',
      version: '1.0.0',
    });
  });
});

describe('ExtensionClient', () => {
  let client: ExtensionClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new ExtensionClient('http://localhost:3100');
  });

  describe('resolveExtensions', () => {
    it('returns empty array for no ids', async () => {
      const result = await client.resolveExtensions([]);
      expect(result).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('resolves a single extension ID (no version)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          _id: 'ms-python.python',
          publisher: 'ms-python',
          name: 'Python',
          origin: 'marketplace',
          createdAt: new Date().toISOString(),
        }),
      });

      const result = await client.resolveExtensions(['ms-python.python']);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        id: 'ms-python.python',
        version: undefined,
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3100/api/v1/extensions/ms-python.python'
      );
    });

    it('resolves extension spec with @version', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          _id: 'ms-python.python',
          publisher: 'ms-python',
          name: 'Python',
          origin: 'marketplace',
          createdAt: new Date().toISOString(),
        }),
      });

      const result = await client.resolveExtensions(['ms-python.python@2024.22.1']);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        id: 'ms-python.python',
        version: '2024.22.1',
      });
      // Should strip @version when calling the API
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3100/api/v1/extensions/ms-python.python'
      );
    });

    it('resolves multiple extension specs', async () => {
      for (const id of ['ms-python.python', 'GitHub.copilot']) {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            _id: id,
            publisher: id.split('.')[0],
            name: id.split('.')[1],
            origin: 'marketplace',
            createdAt: new Date().toISOString(),
          }),
        });
      }

      const result = await client.resolveExtensions(['ms-python.python@2024.22.1', 'GitHub.copilot']);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ id: 'ms-python.python', version: '2024.22.1' });
      expect(result[1]).toEqual({ id: 'GitHub.copilot', version: undefined });
    });

    it('throws on 404', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

      await expect(client.resolveExtensions(['non.existent']))
        .rejects.toThrow("Extension 'non.existent' not found via API");
    });

    it('throws on 404 for spec with version', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

      await expect(client.resolveExtensions(['non.existent@1.0.0']))
        .rejects.toThrow("Extension 'non.existent' not found via API");
    });

    it('throws on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal Server Error' });

      await expect(client.resolveExtensions(['some.ext']))
        .rejects.toThrow('[ExtensionClient] GET http://localhost:3100/api/v1/extensions/some.ext failed: 500 Internal Server Error');
    });
  });

  describe('searchMarketplace', () => {
    it('parses marketplace results', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          results: [{
            extensions: [
              {
                publisher: { publisherName: 'ms-python' },
                extensionName: 'python',
                displayName: 'Python',
                shortDescription: 'Python language support',
                versions: [{ version: '2024.22.1' }],
              },
            ],
          }],
        }),
      });

      const results = await client.searchMarketplace('python');

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        id: 'ms-python.python',
        name: 'Python',
        publisher: 'ms-python',
        description: 'Python language support',
        internal: false,
        version: '2024.22.1',
      });
    });

    it('returns empty array on no results', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ results: [{ extensions: [] }] }),
      });

      const results = await client.searchMarketplace('nonexistent');
      expect(results).toEqual([]);
    });

    it('throws on marketplace HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      });

      await expect(client.searchMarketplace('python'))
        .rejects.toThrow('Marketplace search failed: 503 Service Unavailable');
    });
  });

  describe('getVersions', () => {
    it('returns versions with pre-release flags', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          results: [{
            extensions: [{
              publisher: { publisherName: 'ms-python' },
              extensionName: 'python',
              displayName: 'Python',
              versions: [
                {
                  version: '2026.4.0',
                  lastUpdated: '2026-04-01T00:00:00Z',
                  properties: [],
                },
                {
                  version: '2026.5.0-pre.1',
                  lastUpdated: '2026-04-01T00:00:00Z',
                  properties: [{ key: 'Microsoft.VisualStudio.Code.PreRelease', value: 'true' }],
                },
                {
                  version: '2026.3.0',
                  lastUpdated: '2026-03-15T00:00:00Z',
                  properties: [],
                },
              ],
            }],
          }],
        }),
      });

      const versions = await client.getVersions('ms-python.python', true);

      expect(versions).toHaveLength(3);
      expect(versions[0]).toEqual({
        version: '2026.4.0',
        preRelease: false,
        lastUpdated: '2026-04-01T00:00:00Z',
      });
      expect(versions[1]).toEqual({
        version: '2026.5.0-pre.1',
        preRelease: true,
        lastUpdated: '2026-04-01T00:00:00Z',
      });
    });

    it('filters pre-release versions by default', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          results: [{
            extensions: [{
              publisher: { publisherName: 'ms-python' },
              extensionName: 'python',
              displayName: 'Python',
              versions: [
                { version: '2026.4.0', properties: [] },
                { version: '2026.5.0-pre.1', properties: [{ key: 'Microsoft.VisualStudio.Code.PreRelease', value: 'true' }] },
                { version: '2026.3.0', properties: [] },
              ],
            }],
          }],
        }),
      });

      const versions = await client.getVersions('ms-python.python', false);

      expect(versions).toHaveLength(2);
      expect(versions.every(v => !v.preRelease)).toBe(true);
    });

    it('returns empty array when no versions', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ results: [{ extensions: [{ versions: [] }] }] }),
      });

      const versions = await client.getVersions('ms-python.python');
      expect(versions).toEqual([]);
    });

    it('throws on marketplace error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      });

      await expect(client.getVersions('ms-python.python'))
        .rejects.toThrow('Marketplace version query failed: 503 Service Unavailable');
    });

    it('throws on invalid extension ID', async () => {
      await expect(client.getVersions('invalid'))
        .rejects.toThrow('Invalid extension ID: invalid');
    });

    it('deduplicates versions with the same version string (platform-specific builds)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          results: [{
            extensions: [{
              publisher: { publisherName: 'ms-windows-ai-studio' },
              extensionName: 'windows-ai-studio',
              displayName: 'AI Toolkit',
              versions: [
                { version: '0.34.0', lastUpdated: '2026-04-01T00:00:00Z', properties: [], targetPlatform: 'win32-x64' },
                { version: '0.34.0', lastUpdated: '2026-04-01T00:00:00Z', properties: [], targetPlatform: 'linux-x64' },
                { version: '0.34.0', lastUpdated: '2026-04-01T00:00:00Z', properties: [], targetPlatform: 'darwin-arm64' },
                { version: '0.33.0', lastUpdated: '2026-03-15T00:00:00Z', properties: [], targetPlatform: 'win32-x64' },
                { version: '0.33.0', lastUpdated: '2026-03-15T00:00:00Z', properties: [], targetPlatform: 'linux-x64' },
                { version: '0.33.0', lastUpdated: '2026-03-15T00:00:00Z', properties: [], targetPlatform: 'darwin-arm64' },
              ],
            }],
          }],
        }),
      });

      const versions = await client.getVersions('ms-windows-ai-studio.windows-ai-studio');

      expect(versions).toHaveLength(2);
      expect(versions[0]!.version).toBe('0.34.0');
      expect(versions[1]!.version).toBe('0.33.0');
    });
  });
});
