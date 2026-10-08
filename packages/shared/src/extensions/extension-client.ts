// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ExtensionConfig, ExtensionDocument, ExtensionSearchResult, ExtensionVersionInfo } from '../types/extension.js';
import { parseExtensionSpec } from '../types/extension.js';

/** VS Code marketplace Gallery API response types (subset). */
interface MarketplaceExtension {
  publisher: { publisherName: string };
  extensionName: string;
  displayName: string;
  shortDescription?: string;
  versions?: Array<{ version: string; lastUpdated?: string; properties?: Array<{ key: string; value: string }> }>;
}

interface MarketplaceResponse {
  results: Array<{
    extensions: MarketplaceExtension[];
  }>;
}

/**
 * Client for searching VS Code marketplace extensions and resolving
 * extension IDs via the Scope REST API.
 */
export class ExtensionClient {
  private readonly apiUrl: string;
  private static readonly MARKETPLACE_URL =
    "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery";

  constructor(apiUrl: string) {
    this.apiUrl = apiUrl.replace(/\/+$/, '');
  }

  /**
   * Search the VS Code marketplace for extensions matching a query.
   *
   * Uses the public Gallery Extension Query API.
   * @see https://learn.microsoft.com/en-us/rest/api/azure/devops/extensionmanagement/installed-extensions/list
   */
  async searchMarketplace(query: string, limit = 10): Promise<ExtensionSearchResult[]> {
    const body = {
      filters: [
        {
          criteria: [
            { filterType: 8, value: "Microsoft.VisualStudio.Code" },
            { filterType: 10, value: query },
          ],
          pageNumber: 1,
          pageSize: limit,
          sortBy: 0,
          sortOrder: 0,
        },
      ],
      assetTypes: [],
      flags: 914,
    };

    const res = await fetch(ExtensionClient.MARKETPLACE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json;api-version=7.1-preview.1",
        "User-Agent": "scope-mt-api",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      throw new Error(`Marketplace search failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as MarketplaceResponse;
    const extensions = data.results?.[0]?.extensions ?? [];

    return extensions.map((ext) => ({
      id: `${ext.publisher.publisherName}.${ext.extensionName}`,
      name: ext.displayName,
      publisher: ext.publisher.publisherName,
      description: ext.shortDescription,
      internal: false,
      version: ext.versions?.[0]?.version,
    }));
  }

  /**
   * Resolve an array of extension specs ("id" or "id@version") to their configurations.
   * Validates each extension exists via the API, then overlays the version from the spec.
   *
   * @param projectId - Project scope of the run whose extensions are resolved
   * @param specs - Extension specs (e.g. "ms-python.python" or "ms-python.python@2024.22.1")
   * @throws Error if any extension cannot be resolved (404 or HTTP error)
   */
  async resolveExtensions(projectId: string, specs: string[]): Promise<ExtensionConfig[]> {
    if (specs.length === 0) return [];

    const configs: ExtensionConfig[] = [];
    const projectQuery = `?projectId=${encodeURIComponent(projectId)}`;

    for (const spec of specs) {
      const { id, version } = parseExtensionSpec(spec);
      const url = `${this.apiUrl}/api/v1/extensions/${encodeURIComponent(id)}${projectQuery}`;
      const res = await fetch(url);

      if (res.status === 404) {
        throw new Error(`Extension '${id}' not found via API`);
      }
      if (!res.ok) {
        throw new Error(`[ExtensionClient] GET ${url} failed: ${res.status} ${res.statusText}`);
      }

      // Validate the extension exists — we don't need the document fields, just confirmation
      await res.json();
      configs.push({ id, version });
    }

    return configs;
  }

  /**
   * Fetch available versions for a specific extension from the VS Code marketplace.
   *
   * @param extensionId - Extension ID (e.g. "ms-python.python")
   * @param includePreRelease - Whether to include pre-release versions
   * @returns Array of version info objects, most recent first
   */
  async getVersions(extensionId: string, includePreRelease = false): Promise<ExtensionVersionInfo[]> {
    const [publisher, name] = extensionId.split(".");
    if (!publisher || !name) {
      throw new Error(`Invalid extension ID: ${extensionId}`);
    }

    const body = {
      filters: [
        {
          criteria: [
            { filterType: 8, value: "Microsoft.VisualStudio.Code" },
            { filterType: 7, value: `${publisher}.${name}` },
          ],
          pageNumber: 1,
          pageSize: 1,
          sortBy: 0,
          sortOrder: 0,
        },
      ],
      assetTypes: [],
      flags: 0x1 | 0x10, // IncludeVersions (all versions) | IncludeVersionProperties (pre-release flag)
    };

    const res = await fetch(ExtensionClient.MARKETPLACE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json;api-version=7.1-preview.1",
        "User-Agent": "scope-mt-api",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      throw new Error(`Marketplace version query failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as MarketplaceResponse;
    const ext = data.results?.[0]?.extensions?.[0];
    if (!ext?.versions) return [];

    const seen = new Set<string>();
    return ext.versions
      .map((v) => {
        const isPreRelease = v.properties?.some(
          (p) => p.key === "Microsoft.VisualStudio.Code.PreRelease" && p.value === "true"
        ) ?? false;
        return {
          version: v.version,
          preRelease: isPreRelease,
          lastUpdated: v.lastUpdated ?? "",
        };
      })
      .filter((v) => {
        if (seen.has(v.version)) return false;
        seen.add(v.version);
        return includePreRelease || !v.preRelease;
      });
  }
}
