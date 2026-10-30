// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash, randomUUID } from "node:crypto";
import type { Collection } from "mongodb";
import type {
  PortableTaxonomyDocument,
  PortableTaxonomyElementDocument,
  TaxonomyDocument,
  TaxonomyElementDocument,
  TaxonomyElementRevisionDocument,
  TaxonomyRevisionDocument,
} from "../types/taxonomy.js";
import type { TaxonomyRootStore } from "./taxonomy-store.js";

type RevisionDocument =
  | TaxonomyRevisionDocument
  | TaxonomyElementRevisionDocument;
type PortableDocument =
  | PortableTaxonomyDocument
  | PortableTaxonomyElementDocument;
type RootDocument = TaxonomyDocument | TaxonomyElementDocument;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function taxonomyContentSha256(content: PortableDocument): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(content)))
    .digest("hex");
}

/** Store for one immutable taxonomy revision collection. */
export class TaxonomyRevisionStore<
  TRevision extends RevisionDocument,
  TRoot extends RootDocument,
  TContent extends PortableDocument,
> {
  constructor(
    private readonly collection: Collection<TRevision>,
    private readonly rootStore: TaxonomyRootStore<TRoot>,
    private readonly rootKey: "taxonomyId" | "elementId",
  ) {}

  async get(id: string): Promise<TRevision | null> {
    return this.collection.findOne({ _id: id } as never) as Promise<TRevision | null>;
  }

  async getByRef(projectId: string, ref: string): Promise<TRevision | null> {
    return this.collection.findOne({ projectId, ref } as never) as Promise<TRevision | null>;
  }

  async getMany(ids: readonly string[]): Promise<TRevision[]> {
    if (ids.length === 0) return [];
    return this.collection
      .find({ _id: { $in: [...new Set(ids)] } } as never)
      .toArray() as Promise<TRevision[]>;
  }

  async getByRefs(
    projectId: string,
    refs: readonly string[],
  ): Promise<TRevision[]> {
    if (refs.length === 0) return [];
    return this.collection
      .find({
        projectId,
        ref: { $in: [...new Set(refs)] },
      } as never)
      .toArray() as Promise<TRevision[]>;
  }

  async getLatest(rootId: string): Promise<TRevision | null> {
    return this.collection
      .find({ [this.rootKey]: rootId } as never)
      .sort({ revision: -1 })
      .limit(1)
      .next() as Promise<TRevision | null>;
  }

  async list(rootId: string): Promise<TRevision[]> {
    return this.collection
      .find({ [this.rootKey]: rootId } as never)
      .sort({ revision: -1 })
      .toArray() as Promise<TRevision[]>;
  }

  async create(
    rootId: string,
    content: TContent,
    creator?: string,
  ): Promise<{ revision: TRevision; deduplicated: boolean }> {
    const root = await this.rootStore.get(rootId);
    if (!root) throw new Error(`Taxonomy root '${rootId}' not found`);
    if (root.sourceType === "builtin" && root.revisionCounter > 0) {
      throw new Error("Built-in taxonomy content is read-only");
    }

    const contentSha256 = taxonomyContentSha256(content);
    const latest = await this.getLatest(rootId);
    if (latest?.contentSha256 === contentSha256) {
      return { revision: latest, deduplicated: true };
    }

    const allocated = await this.rootStore.allocateRevision(rootId);
    if (!allocated) throw new Error(`Taxonomy root '${rootId}' not found`);
    const revision = allocated.revisionCounter;
    const document = {
      ...content,
      _id: randomUUID(),
      [this.rootKey]: rootId,
      projectId: root.projectId,
      sourceType: root.sourceType,
      revision,
      ref: `${content.id}@r${revision}`,
      contentSha256,
      ...(creator ? { creator } : {}),
      createdAt: new Date(),
    } as unknown as TRevision;
    await this.collection.insertOne(document as never);
    await this.rootStore.setLatest(rootId, document._id, revision);
    return { revision: document, deduplicated: false };
  }
}
