// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Project } from "@/types";

/**
 * Project pickers (header switcher, first-run card) show a search box only
 * when there are more projects than this, so a handful of projects keeps the
 * plain list (issue #1311).
 */
export const PROJECT_SEARCH_THRESHOLD = 8;

/** Whether a project picker should offer search for `projectCount` projects. */
export function shouldSearchProjects(projectCount: number): boolean {
  return projectCount > PROJECT_SEARCH_THRESHOLD;
}

/**
 * Filter projects by a free-text query, matching name or description
 * case-insensitively. A blank query returns every project unchanged.
 *
 * @param projects - Projects in display order; the order is preserved.
 * @param query - Raw search text; surrounding whitespace is ignored.
 */
export function filterProjects(projects: Project[], query: string): Project[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return projects;

  return projects.filter(
    (project) =>
      project.name.toLowerCase().includes(needle) ||
      (project.description?.toLowerCase().includes(needle) ?? false),
  );
}
