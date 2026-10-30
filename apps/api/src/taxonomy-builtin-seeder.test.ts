// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, vi } from "vitest";
import { ensureBuiltinTaxonomy } from "./taxonomy-builtin-seeder.js";

describe("ensureBuiltinTaxonomy", () => {
  it("derives the active root identity, display, version, and ref from YAML", async () => {
    const elementRoots = new Map<string, { _id: string; id: string }>();
    const taxonomyStore = {
      getByBusinessId: vi.fn(async () => null),
      create: vi.fn(async (input: { id: string; name: string; description: string }) => ({
        _id: "taxonomy-root",
        projectId: "project-1",
        revisionCounter: 0,
        sourceType: "builtin",
        createdAt: new Date(),
        ...input,
      })),
    };
    const taxonomyElementStore = {
      getByBusinessId: vi.fn(async (_projectId: string, id: string) =>
        elementRoots.get(id) ?? null
      ),
      create: vi.fn(async (input: { id: string }) => {
        const root = { _id: `root-${input.id}`, id: input.id };
        elementRoots.set(input.id, root);
        return root;
      }),
    };
    const taxonomyElementRevisionStore = {
      getLatest: vi.fn(async () => null),
      create: vi.fn(async (_rootId: string, content: { id: string }) => ({
        revision: { ref: `${content.id}@r1` },
        deduplicated: false,
      })),
    };
    const taxonomyRevisionStore = {
      create: vi.fn(async (
        _rootId: string,
        content: { id: string; version: string },
      ) => ({
        revision: { ref: `${content.id}@r1`, ...content },
        deduplicated: false,
      })),
    };

    await ensureBuiltinTaxonomy({
      taxonomyStore,
      taxonomyElementStore,
      taxonomyElementRevisionStore,
      taxonomyRevisionStore,
    } as never, "project-1");

    expect(taxonomyStore.create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "ax-taxonomy",
        name: "ax-taxonomy",
        description: "ax-taxonomy 1.0.0",
      }),
    );
    expect(taxonomyRevisionStore.create).toHaveBeenCalledWith(
      "taxonomy-root",
      expect.objectContaining({
        id: "ax-taxonomy",
        version: "1.0.0",
        elements: expect.arrayContaining([
          { ref: "beh-discovered@r1" },
          { ref: "beh-timeout@r1" },
        ]),
      }),
      "system",
    );
  });
});
