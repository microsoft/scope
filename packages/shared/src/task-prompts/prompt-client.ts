// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { fetchWithBearer, type BearerProvider } from "../http/bearer.js";
/**
 * Client for resolving prompt text (task or AGENTS.md) via the Scope REST API.
 *
 * Used by queue processors at message-processing time to fetch the resolved
 * plain-text body of a prompt (inline or blob-backed) without needing direct
 * blob storage access. The API endpoint `GET /api/v1/task-prompts/:id/content`
 * runs `resolvePromptText` server-side and returns `{ id, text }`.
 */
export class PromptClient {
  private readonly apiUrl: string;
  /** Supplies the run token (when present) for API calls. */
  private readonly bearer?: BearerProvider;

  constructor(apiUrl: string, bearer?: BearerProvider) {
    this.apiUrl = apiUrl.replace(/\/+$/, "");
    this.bearer = bearer;
  }

  /**
   * Fetch the resolved plain-text body of a prompt by id.
   *
   * @param id - Prompt id (content hash) of a task or agents.md prompt.
   * @throws Error if the prompt cannot be resolved (404 or HTTP error).
   */
  async getText(id: string): Promise<string> {
    const url = `${this.apiUrl}/api/v1/task-prompts/${encodeURIComponent(id)}/content`;
    const res = await fetchWithBearer(url, this.bearer);

    if (res.status === 404) {
      throw new Error(`Prompt '${id}' not found via API`);
    }
    if (!res.ok) {
      throw new Error(`[PromptClient] GET ${url} failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as { id: string; text: string };
    if (typeof data.text !== "string") {
      throw new Error(`[PromptClient] GET ${url} returned no text for prompt '${id}'`);
    }
    return data.text;
  }
}
