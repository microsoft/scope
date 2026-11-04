// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, vi } from "vitest";
import {
  listTaxonomyRows,
  resolveTaxonomyDetail,
  type TaxonomyRouteStores,
} from "./taxonomies.js";

const createdAt = new Date("2026-10-29T00:00:00Z");

const taxonomyRoot = {
  _id: "taxonomy-root",
  projectId: "project-a",
  id: "example",
  name: "Example taxonomy",
  sourceType: "user" as const,
  revisionCounter: 2,
  latestRevisionId: "taxonomy-revision-2",
  latestRevision: 2,
  createdAt,
};

const revision1 = {
  _id: "taxonomy-revision-1",
  taxonomyId: taxonomyRoot._id,
  projectId: taxonomyRoot.projectId,
  sourceType: "user" as const,
  schema_version: "scope/taxonomy/v1" as const,
  id: taxonomyRoot.id,
  version: "1.0.0",
  surfaces: [],
  elements: [{ ref: "element-b@r1" }, { ref: "element-a@r1" }],
  revision: 1,
  ref: "example@r1",
  contentSha256: "1".repeat(64),
  createdAt,
};

const revision2 = {
  ...revision1,
  _id: "taxonomy-revision-2",
  version: "1.1.0",
  elements: [{ ref: "element-a@r2" }],
  revision: 2,
  ref: "example@r2",
  contentSha256: "2".repeat(64),
};

function elementRevision(
  rootId: string,
  id: string,
  ref: string,
  revision: number,
) {
  return {
    _id: `${rootId}-revision-${revision}`,
    elementId: rootId,
    projectId: taxonomyRoot.projectId,
    sourceType: "user" as const,
    id,
    label: id.toUpperCase(),
    implementation: { type: "prompt" as const, prompt: `Prompt ${id}` },
    preconditions: {},
    output: { evidence_roles: {} },
    revision,
    ref,
    contentSha256: String(revision).repeat(64),
    createdAt,
  };
}

function elementRoot(rootId: string, id: string) {
  return {
    _id: rootId,
    projectId: taxonomyRoot.projectId,
    id,
    name: id.toUpperCase(),
    sourceType: "user" as const,
    revisionCounter: 2,
    latestRevision: 2,
    createdAt,
  };
}

describe("taxonomy detail projection", () => {
  it("resolves one historical taxonomy revision with exact ordered elements", async () => {
    const elementA = elementRevision("root-a", "element-a", "element-a@r1", 1);
    const elementB = elementRevision("root-b", "element-b", "element-b@r1", 1);
    const stores = {
      taxonomyStore: {
        get: vi.fn(async () => taxonomyRoot),
      },
      taxonomyRevisionStore: {
        list: vi.fn(async () => [revision2, revision1]),
      },
      taxonomyElementRevisionStore: {
        getByRefs: vi.fn(async () => [elementA, elementB]),
      },
      taxonomyElementStore: {
        getMany: vi.fn(async () => [
          elementRoot("root-a", "element-a"),
          elementRoot("root-b", "element-b"),
        ]),
      },
    } as unknown as TaxonomyRouteStores;

    const detail = await resolveTaxonomyDetail(
      stores,
      taxonomyRoot.projectId,
      taxonomyRoot._id,
      revision1._id,
    );

    expect(detail?.selectedRevision.ref).toBe("example@r1");
    expect(detail?.elements.map(element => element.revision.ref)).toEqual([
      "element-b@r1",
      "element-a@r1",
    ]);
    expect(detail?.elements.map(element => element.position)).toEqual([0, 1]);
    expect(detail?.revisions).toEqual([
      expect.objectContaining({ ref: "example@r2", isLatest: true }),
      expect.objectContaining({ ref: "example@r1", isLatest: false }),
    ]);
    expect(stores.taxonomyElementRevisionStore.getByRefs)
      .toHaveBeenCalledOnce();
    expect(stores.taxonomyElementStore.getMany).toHaveBeenCalledOnce();
  });

  it("rejects a root outside the requested project before revision reads", async () => {
    const stores = {
      taxonomyStore: { get: vi.fn(async () => taxonomyRoot) },
      taxonomyRevisionStore: { list: vi.fn() },
    } as unknown as TaxonomyRouteStores;

    await expect(resolveTaxonomyDetail(
      stores,
      "project-b",
      taxonomyRoot._id,
    )).resolves.toBeNull();
    expect(stores.taxonomyRevisionStore.list).not.toHaveBeenCalled();
  });

  it("enriches taxonomy rows with one bulk latest-revision read", async () => {
    const stores = {
      taxonomyStore: { list: vi.fn(async () => [taxonomyRoot]) },
      taxonomyRevisionStore: { getMany: vi.fn(async () => [revision2]) },
    } as unknown as TaxonomyRouteStores;

    await expect(listTaxonomyRows(stores, taxonomyRoot.projectId)).resolves
      .toEqual([expect.objectContaining({
        _id: taxonomyRoot._id,
        ref: "example@r2",
        version: "1.1.0",
        elementCount: 1,
      })]);
    expect(stores.taxonomyRevisionStore.getMany).toHaveBeenCalledWith([
      revision2._id,
    ]);
  });
});
