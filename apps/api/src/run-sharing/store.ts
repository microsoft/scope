// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Collection } from "mongodb";
import { withRetry } from "shared";
import {
  RUN_SHARE_PAGE, RunShareTokenSchema,
  type RunShare, type RunShareContent, type RunShareLink, type RunShareList, type UpdateRunShare,
} from "shared/run-sharing";

export interface RunShareDocument {
  _id: string;
  requestId: string;
  runId: string;
  projectId: string;
  createdBy: string;
  tokenHash: string;
  label: string;
  content: RunShareContent;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

export interface ShareTarget {
  requestId: string;
  runId: string;
  projectId: string;
}
export interface SharePublisher extends ShareTarget {
  createdBy: string;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function mintToken(id: string): string {
  return `${id}.${randomBytes(32).toString("base64url")}`;
}

export function shareMetadata(doc: RunShareDocument): RunShare {
  return {
    id: doc._id,
    requestId: doc.requestId,
    runId: doc.runId,
    label: doc.label,
    content: doc.content,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    expiresAt: doc.expiresAt?.toISOString() ?? null,
    revokedAt: doc.revokedAt?.toISOString() ?? null,
  };
}

export class RunShareStore {
  constructor(private readonly collection: Collection<RunShareDocument>) {}

  async create(
    publisher: SharePublisher,
    policy: { label: string; content: RunShareContent; expiresAt: Date | null },
  ): Promise<RunShareLink> {
    const now = new Date();
    const id = randomUUID();
    const token = mintToken(id);
    const doc: RunShareDocument = {
      _id: id, ...publisher, ...policy,
      tokenHash: hashToken(token), createdAt: now, updatedAt: now, revokedAt: null,
    };
    // Retry throttling only; an ambiguous insert must not mint another capability.
    await withRetry(() => this.collection.insertOne(doc));
    return { share: shareMetadata(doc), path: `${RUN_SHARE_PAGE}#${token}` };
  }

  async list(publisher: SharePublisher, after?: string): Promise<RunShareList> {
    const docs = await withRetry(() => this.collection.find({
      ...publisher, ...(after ? { _id: { $gt: after } } : {}),
    }).sort({ _id: 1 }).limit(51).toArray());
    return {
      data: docs.slice(0, 50).map(shareMetadata),
      next: docs.length > 50 ? docs[49]._id : null,
    };
  }

  async update(publisher: SharePublisher, id: string, policy: UpdateRunShare): Promise<RunShare | null> {
    const patch: Partial<RunShareDocument> = { updatedAt: new Date() };
    if (policy.label !== undefined) patch.label = policy.label;
    if (policy.content !== undefined) patch.content = policy.content;
    if (policy.expiresAt !== undefined) patch.expiresAt = policy.expiresAt ? new Date(policy.expiresAt) : null;
    const doc = await withRetry(() => this.collection.findOneAndUpdate(
      { _id: id, ...publisher, revokedAt: null },
      { $set: patch },
      { returnDocument: "after" },
    ));
    return doc ? shareMetadata(doc) : null;
  }

  async revoke(publisher: SharePublisher, id: string): Promise<RunShare | null> {
    const now = new Date();
    const doc = await withRetry(() => this.collection.findOneAndUpdate(
      { _id: id, ...publisher },
      { $set: { revokedAt: now, updatedAt: now } },
      { returnDocument: "after" },
    ));
    return doc ? shareMetadata(doc) : null;
  }

  async rotate(publisher: SharePublisher, id: string): Promise<RunShareLink | null> {
    const token = mintToken(id);
    const doc = await withRetry(() => this.collection.findOneAndUpdate(
      { _id: id, ...publisher, revokedAt: null },
      { $set: { tokenHash: hashToken(token), updatedAt: new Date() } },
      { returnDocument: "after" },
    ));
    return doc ? { share: shareMetadata(doc), path: `${RUN_SHARE_PAGE}#${token}` } : null;
  }

  async resolve(token: string): Promise<RunShareDocument | null> {
    if (!RunShareTokenSchema.safeParse(token).success) return null;
    const doc = await withRetry(() => this.collection.findOne({
      _id: token.split(".", 1)[0], tokenHash: hashToken(token), revokedAt: null,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
    }));
    return doc;
  }
}
