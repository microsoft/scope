// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { stripTrailingSlashes } from "./url";

/**
 * Central helpers for linking from the portal into the public Scope docs site.
 *
 * The docs base URL is runtime-configurable so it can differ per environment
 * without rebuilding the static bundle: it is read from
 * `window.__SCOPE_CONFIG__.docsBaseUrl` (injected via `/config.js` — see
 * `apps/portal/public/config.js` and the container entrypoint). When the
 * runtime config is absent we fall back to {@link DEFAULT_DOCS_BASE}.
 *
 * We centralise the URLs here so:
 *  - components only depend on a stable named key (not a hard-coded URL),
 *  - if the docs site moves or restructures, only this file needs to change.
 */

/** Fallback docs base used when no runtime config is provided. */
export const DEFAULT_DOCS_BASE = "https://urban-disco-1qzzq7z.pages.github.io";

/**
 * Resolve the docs base URL from runtime config, falling back to the default.
 * Any trailing slash is stripped so it can be concatenated with slugs that
 * already start with `/` without producing a double slash.
 */
export function getDocsBase(): string {
  const configured =
    typeof window !== "undefined" ? window.__SCOPE_CONFIG__?.docsBaseUrl : undefined;
  const base = configured && configured.trim() !== "" ? configured : DEFAULT_DOCS_BASE;
  return stripTrailingSlashes(base);
}

/**
 * Named docs pages referenced by in-app tooltips and contextual help links.
 * Keys are stable identifiers used in components; values are the slug path
 * appended to `getDocsBase()`. Trailing slashes match the Starlight URL pattern.
 */
export const DOCS_PAGES = {
  concepts: "/introduction/concepts/",
  criteria: "/guides/defining-criteria/",
  criteriaSchema: "/reference/criteria-schema/",
  profiles: "/guides/defining-profiles/",
  profileSchema: "/reference/profile-schema/",
  promptFeatures: "/guides/prompt-features/",
  promptFeatureSchema: "/reference/prompt-feature-schema/",
  skills: "/guides/importing-skills/",
  mcpServers: "/guides/importing-mcp-servers/",
  extensions: "/guides/importing-extensions/",
  taskPrompts: "/guides/managing-task-prompts/",
  choosingAgent: "/guides/choosing-a-coding-agent/",
  submitRunPortal: "/guides/submitting-requests-portal/",
  workers: "/reference/workers/",
  glossary: "/resources/glossary/",
} as const;

export type DocsPage = keyof typeof DOCS_PAGES;

/**
 * Build a full docs URL for a named page.
 */
export function docsUrl(page: DocsPage): string {
  return `${getDocsBase()}${DOCS_PAGES[page]}`;
}
