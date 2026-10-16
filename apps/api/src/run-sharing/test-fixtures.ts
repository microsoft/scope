// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { vi } from "vitest";
import type { Filter } from "mongodb";
import { SUMMARY_SHARE_CONTENT } from "shared/run-sharing";
import type { RequestDocument } from "../route-context.js";
import { createMockCollection } from "../test-helpers.js";
import type { RunShareDocument } from "./store.js";

export const shareId = "11111111-2222-4333-8444-555555555555";
export const token = `${shareId}.${"A".repeat(43)}`;
export const at = new Date("2026-01-01T00:00:00.000Z");
export const blobUrl = (name: string, container = "snapshots") =>
  `https://storage.example.test/${container}/request-1/runs/attempt-1/${name}`;

export function makeRequest(): RequestDocument {
  return {
    _id: "request-1", projectId: "project-1", createdAt: at, priority: 0,
    scenario: { task: "PRIVATE_TASK", criteria: ["criterion-1"] },
    workerType: "coder-acp-copilot", model: "example-model",
    personaInstructions: "PRIVATE_PERSONA",
    agentsMdPromptId: "agents-private",
    run: {
      _id: "attempt-1", attemptNumber: 1, status: "done", outcome: "succeeded",
      startedAt: at, finishedAt: new Date(at.getTime() + 1000),
      error: "PRIVATE_ERROR", result: "PRIVATE_RESULT",
      logsUrl: blobUrl("run.jsonl", "logs"), harUrl: blobUrl("capture.har"),
      rawChatUrl: blobUrl("raw.json"), videoUrls: [blobUrl("recording.webm")],
      worker: { instanceId: "PRIVATE_WORKER" },
      turns: [{
        iteration: 1, timestamp: at, passed: true,
        snapshotUrl: blobUrl("iteration-1/workspace.tar.gz"),
        codingAgentResponse: "PRIVATE_CONVERSATION", judgeFeedback: "PRIVATE_JUDGE",
        toolCalls: [{ id: "call-1", name: "PRIVATE_TOOL", arguments: { secret: "PRIVATE_ARGUMENT" } }],
        criteriaResults: [{ criterionId: "criterion-1", passed: true, evaluated: true, feedback: "PRIVATE_FEEDBACK" }],
      }],
    },
  };
}

export function makeShare(overrides: Partial<RunShareDocument> = {}): RunShareDocument {
  return {
    _id: shareId, requestId: "request-1", runId: "attempt-1", projectId: "project-1",
    createdBy: "user-1", tokenHash: "not-a-real-token-hash", label: "Benchmark result",
    content: { ...SUMMARY_SHARE_CONTENT }, createdAt: at, updatedAt: at, revokedAt: null,
    expiresAt: new Date("2099-01-01T00:00:00.000Z"), ...overrides,
  };
}

export function memoryShares() {
  const documents = new Map<string, RunShareDocument>();
  const collection = createMockCollection<RunShareDocument>();
  function matches(doc: RunShareDocument, filter: Filter<RunShareDocument>) {
    for (const key of ["requestId", "runId", "projectId", "createdBy", "tokenHash"] as const) {
      if (typeof filter[key] === "string" && doc[key] !== filter[key]) return false;
    }
    if (typeof filter._id === "string" && doc._id !== filter._id) return false;
    if (filter._id && typeof filter._id === "object" && "$gt" in filter._id &&
        typeof filter._id.$gt === "string" && doc._id <= filter._id.$gt) return false;
    if (filter.revokedAt === null && doc.revokedAt !== null) return false;
    if (filter.$or && doc.expiresAt && doc.expiresAt.getTime() <= Date.now()) return false;
    return true;
  }
  vi.mocked(collection.insertOne).mockImplementation(async (doc) => {
    documents.set(doc._id, { ...doc });
    return { acknowledged: true, insertedId: doc._id };
  });
  vi.mocked(collection.findOne).mockImplementation(async (filter) =>
    [...documents.values()].find((doc) => matches(doc, filter)) ?? null);
  vi.mocked(collection.find).mockImplementation((filter = {}) =>
    createMockCollection<RunShareDocument>(
      [...documents.values()].filter((doc) => matches(doc, filter)).sort((a, b) => a._id.localeCompare(b._id)).slice(0, 51),
    ).find({}));
  vi.mocked(collection.findOneAndUpdate).mockImplementation(async (filter, update) => {
    const doc = [...documents.values()].find((item) => matches(item, filter));
    if (!doc) return null;
    if (Array.isArray(update) || !update.$set) throw new Error("Unsupported test update");
    Object.assign(doc, update.$set);
    return doc;
  });
  return { collection, documents };
}
