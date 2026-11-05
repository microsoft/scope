// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash } from "node:crypto";
import { MongoServerError, type Db, type Document, type Filter } from "mongodb";

export class AccessError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

export type SecurityTarget = "users" | "projects" | "project_memberships";
export interface AdminIntent {
  _id: string;
  actor: string;
  reason: string;
  collection: SecurityTarget;
  targetId: string;
  expectedRevision: number;
  change: Record<string, unknown>;
  unset: string[];
  initial?: Record<string, unknown>;
  condition?: Record<string, unknown>;
  backup?: Record<string, unknown>;
  creatorMembershipOperationId?: string;
}
export interface AdminOperation extends AdminIntent {
  fingerprint: string;
  state: "prepared" | "completed" | "conflict";
  createdAt: Date;
  completedAt?: Date;
}
export interface OperationResult {
  operationId: string;
  state: "completed" | "pending";
  revision: number;
}

function stable(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function adminIntentFingerprint(intent: AdminIntent): string {
  return createHash("sha256").update(stable(intent)).digest("hex");
}

/**
 * A target retains every applied operation ID: A can be reconciled after B has
 * changed the target, without mistaking B's newer state for A's failed write.
 */
export class AdminOperations {
  constructor(private readonly db: Db) {}

  async inspect(id: string): Promise<AdminOperation | null> {
    try {
      return await this.db.collection<AdminOperation>("admin_operations").findOne({ _id: id }, { timeoutMS: 5_000 });
    } catch (error) {
      console.error("Unable to read security operation intent", id, error);
      throw new AccessError(503, "intent_unavailable", "Security operation intent store unavailable");
    }
  }

  async execute(intent: AdminIntent): Promise<OperationResult> {
    const operations = this.db.collection<AdminOperation>("admin_operations");
    const fingerprint = adminIntentFingerprint(intent);
    let operation = await this.inspect(intent._id);
    if (!operation) {
      try {
        const { initial, condition, ...required } = intent;
        operation = { ...required, ...(initial ? { initial } : {}), ...(condition ? { condition } : {}), fingerprint, state: "prepared", createdAt: new Date() };
        await operations.insertOne(operation, { timeoutMS: 5_000 });
      } catch (error) {
        if (!(error instanceof MongoServerError) || error.code !== 11000) {
          console.error("Unable to persist security operation intent", intent._id, error);
          throw new AccessError(503, "intent_unavailable", "Security operation intent could not be persisted");
        }
        operation = await this.inspect(intent._id);
      }
    }
    if (!operation || operation.fingerprint !== fingerprint) {
      throw new AccessError(409, "idempotency_conflict", "Operation ID was already used for different input");
    }
    if (operation.state === "conflict") {
      throw new AccessError(409, "revision_conflict", "Target revision or preconditions changed");
    }
    const revision = operation.expectedRevision + 1;
    if (operation.state === "completed") return { operationId: operation._id, state: "completed", revision };
    const target = this.db.collection<Document & { _id: string }>(operation.collection);
    try {
      let current = await target.findOne({ _id: operation.targetId }, { timeoutMS: 5_000 });
      if (!Array.isArray(current?.appliedOperationIds) || !current.appliedOperationIds.includes(operation._id)) {
        const set = {
          ...Object.fromEntries(Object.entries(operation.change).map(([key, value]) =>
            [key, value === "$operationTime" ? operation.createdAt : value])),
          revision,
          lastOperationId: operation._id,
          updatedAt: new Date(),
        };
        if (!current && operation.initial && operation.expectedRevision === 0) {
          try {
            await target.insertOne({
              ...operation.initial, ...set, _id: operation.targetId,
              createdAt: operation.createdAt, appliedOperationIds: [operation._id],
            }, { timeoutMS: 5_000 });
          } catch (error) {
            if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
          }
        } else {
          const filter: Filter<Document & { _id: string }> = {
            _id: operation.targetId,
            ...operation.condition,
            ...(operation.expectedRevision === 0
              ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] }
              : { revision: operation.expectedRevision }),
          };
          await target.updateOne(filter, {
            $set: set,
            $addToSet: { appliedOperationIds: operation._id },
            ...(operation.unset.length ? { $unset: Object.fromEntries(operation.unset.map(key => [key, ""])) } : {}),
          }, { timeoutMS: 5_000 });
        }
        current = await target.findOne({ _id: operation.targetId }, { timeoutMS: 5_000 });
        if (!Array.isArray(current?.appliedOperationIds) || !current.appliedOperationIds.includes(operation._id)) {
          await operations.updateOne({ _id: operation._id, state: "prepared" }, {
            $set: { state: "conflict", completedAt: new Date() },
          }, { timeoutMS: 5_000 });
          throw new AccessError(409, "revision_conflict", "Target revision or preconditions changed");
        }
      }
      if (operation.creatorMembershipOperationId) {
        try {
          const membership = await this.execute({
            _id: operation.creatorMembershipOperationId,
            actor: operation.actor, reason: "Project creator project-admin membership",
            collection: "project_memberships", targetId: `${operation.targetId}:${operation.actor}`,
            expectedRevision: 0, change: { role: "admin" }, unset: [],
            initial: { projectId: operation.targetId, userId: operation.actor, createdByUserId: operation.actor },
          });
          if (membership.state !== "completed") return { operationId: operation._id, state: "pending", revision };
        } catch (error) {
          console.error("Project creation awaits creator membership reconciliation", operation._id, error);
          return { operationId: operation._id, state: "pending", revision };
        }
      }
      const completion = await operations.updateOne({ _id: operation._id, state: "prepared" }, {
        $set: { state: "completed", completedAt: new Date() },
      }, { timeoutMS: 5_000 });
      if (!completion.acknowledged || (completion.matchedCount !== 1 &&
        !await operations.findOne({ _id: operation._id, fingerprint, state: "completed" }, { timeoutMS: 5_000 }))) {
        throw new Error("Security operation completion was not durably confirmed");
      }
      return { operationId: operation._id, state: "completed", revision };
    } catch (error) {
      if (error instanceof AccessError) throw error;
      console.error("Security operation needs reconciliation", operation._id, error);
      return { operationId: operation._id, state: "pending", revision };
    }
  }

  async reconcile(id: string): Promise<OperationResult> {
    const operation = await this.inspect(id);
    if (!operation) throw new AccessError(404, "not_found", "Operation not found");
    const { fingerprint: _fingerprint, state: _state, createdAt: _createdAt, completedAt: _completedAt, ...intent } = operation;
    return this.execute(intent);
  }

  async isComplete(marker: unknown, timeoutMS = 5_000): Promise<boolean> {
    if (marker === undefined) return true;
    if (typeof marker !== "string") return false;
    return Boolean(await this.db.collection<AdminOperation>("admin_operations")
      .findOne({ _id: marker, state: "completed" }, { projection: { _id: 1 }, timeoutMS }));
  }
}
