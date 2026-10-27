// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { PROJECT_SEARCH_THRESHOLD, filterProjects, shouldSearchProjects } from "./project-search";
import type { Project } from "@/types";

const PROJECTS = [
  { _id: "a", id: "a", name: "Alpha", description: "Primary benchmark" },
  { _id: "b", id: "b", name: "Bravo" },
  { _id: "c", id: "c", name: "Charlie", description: "Secondary BENCHMARK runs" },
] as Project[];

describe("filterProjects", () => {
  it("returns every project for a blank query", () => {
    expect(filterProjects(PROJECTS, "   ")).toBe(PROJECTS);
  });

  it("matches names case-insensitively", () => {
    expect(filterProjects(PROJECTS, "bra").map((p) => p.name)).toEqual(["Bravo"]);
  });

  it("matches descriptions and preserves order", () => {
    expect(filterProjects(PROJECTS, " benchmark ").map((p) => p.name)).toEqual(["Alpha", "Charlie"]);
  });

  it("returns nothing when no project matches", () => {
    expect(filterProjects(PROJECTS, "zulu")).toEqual([]);
  });
});

describe("shouldSearchProjects", () => {
  it("keeps the plain list up to the threshold", () => {
    expect(shouldSearchProjects(PROJECT_SEARCH_THRESHOLD)).toBe(false);
    expect(shouldSearchProjects(PROJECT_SEARCH_THRESHOLD + 1)).toBe(true);
  });
});
