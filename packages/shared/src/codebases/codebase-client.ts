// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { CodebaseConfig, CodebaseRevisionDocument } from "../types/codebase.js";
import { stripTrailingSlashes } from "../utils/strings.js";

/**
 * Client for resolving codebase revisions via the Scope REST API.
 *
 * Used by queue processors at message-processing time to resolve a
 * `codebaseRevisionId` stored on a RequestDocument into a CodebaseConfig and to
 * download the revision archive (proxied through the API, so the worker needs no
 * direct blob storage access).
 */
export class CodebaseClient {
  private readonly apiUrl: string;

  constructor(apiUrl: string) {
    this.apiUrl = stripTrailingSlashes(apiUrl);
  }

  /**
   * Resolve a codebase revision id into a CodebaseConfig.
   *
   * @param revisionId - CodebaseRevisionDocument._id
   * @throws if the revision cannot be resolved (404 or HTTP error)
   */
  async resolveCodebase(revisionId: string): Promise<CodebaseConfig> {
    const url = `${this.apiUrl}/api/v1/codebase-revisions/${encodeURIComponent(revisionId)}`;
    const res = await fetch(url);
    if (res.status === 404) {
      throw new Error(`Codebase revision '${revisionId}' not found via API`);
    }
    if (!res.ok) {
      throw new Error(`[CodebaseClient] GET ${url} failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as CodebaseRevisionDocument;
    return {
      ref: data.ref,
      codebaseId: data.codebaseId,
      revisionId: data._id,
      sourceType: data.sourceType,
      archiveUrl: data.archiveUrl,
    };
  }

  /**
   * Download a codebase revision archive (normalized tar.gz) through the API.
   *
   * @param revisionId - CodebaseRevisionDocument._id
   * @returns Buffer containing the tar.gz archive
   * @throws if the archive cannot be downloaded
   */
  async downloadCodebaseArchive(revisionId: string): Promise<Buffer> {
    const url = `${this.apiUrl}/api/v1/codebase-revisions/${encodeURIComponent(revisionId)}/archive`;
    const res = await fetch(url);
    if (res.status === 404) {
      throw new Error(`Codebase archive for '${revisionId}' not found via API`);
    }
    if (!res.ok) {
      throw new Error(`[CodebaseClient] GET ${url} failed: ${res.status} ${res.statusText}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
