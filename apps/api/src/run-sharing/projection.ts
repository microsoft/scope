// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { runDurationMs, type RunState } from "shared";
import type { SharedRun, SharedRunArtifact } from "shared/run-sharing";
import type { RequestDocument } from "../route-context.js";
import type { RunShareDocument } from "./store.js";

export interface ShareBlobArtifact extends SharedRunArtifact {
  url: string;
  container: "snapshots";
  filename: string;
}

export function sharedArtifacts(share: RunShareDocument, run: RunState): ShareBlobArtifact[] {
  const artifacts: ShareBlobArtifact[] = [];
  const add = (
    id: string, url: string | undefined, label: string,
    category: SharedRunArtifact["category"], contentType: string, extension: string,
  ) => {
    if (!url || !share.content[category]) return;
    artifacts.push({ id, url, label, category, contentType, container: "snapshots", filename: `${id}.${extension}` });
  };
  const rawConversations = share.content.conversations && share.content.prompts && share.content.evaluationDetails;
  if (rawConversations) {
    add("conversation", run.rawChatUrl, "Raw conversation", "conversations", "application/json", "json");
  }
  add("network", run.harUrl, "Run network capture", "network", "application/json", "har");
  run.videoUrls?.forEach((url, index) =>
    add(`video-${index}`, url, `Run video ${index + 1}`, "video", "video/webm", "webm"));
  run.setupVideoUrls?.forEach((url, index) =>
    add(`setup-video-${index}`, url, `Setup video ${index + 1}`, "video", "video/webm", "webm"));
  for (const turn of run.turns ?? []) {
    const prefix = `iteration-${turn.iteration}`;
    add(`${prefix}-snapshot`, turn.snapshotUrl, `Iteration ${turn.iteration} workspace`, "snapshots", "application/gzip", "tar.gz");
    add(`${prefix}-network`, turn.harUrl, `Iteration ${turn.iteration} network capture`, "network", "application/json", "har");
    turn.videoUrls?.forEach((url, index) =>
      add(`${prefix}-video-${index}`, url, `Iteration ${turn.iteration} video ${index + 1}`, "video", "video/webm", "webm"));
    if (rawConversations) {
      add(`${prefix}-conversation`, turn.rawChatUrl, `Iteration ${turn.iteration} raw conversation`, "conversations", "application/json", "json");
      add(`${prefix}-chat-result`, turn.chatResultUrl, `Iteration ${turn.iteration} conversation result`, "conversations", "application/json", "json");
      add(`${prefix}-tool-calls`, turn.toolCallsUrl, `Iteration ${turn.iteration} tool calls`, "conversations", "application/x-ndjson", "jsonl");
    }
  }
  return artifacts;
}

export function projectSharedRun(
  share: RunShareDocument,
  request: RequestDocument,
  run: RunState,
  prompts?: SharedRun["prompts"],
): SharedRun {
  const { content } = share;
  return {
    version: 1,
    label: share.label,
    content,
    expiresAt: share.expiresAt?.toISOString() ?? null,
    run: {
      attemptNumber: run.attemptNumber,
      status: run.status,
      outcome: run.outcome,
      workerType: request.workerType,
      model: request.model,
      agentVersion: request.agentVersion,
      startedAt: run.startedAt?.toISOString(),
      finishedAt: run.finishedAt?.toISOString(),
      durationMs: runDurationMs(run.startedAt, run.finishedAt),
      ...(content.evaluationDetails ? { result: run.result, error: run.error } : {}),
      turns: (run.turns ?? []).map((turn) => ({
        iteration: turn.iteration,
        gate: turn.gate,
        passed: turn.passed,
        timestamp: turn.timestamp.toISOString(),
        durationMs: turn.durationMs,
        criteriaResults: (turn.criteriaResults ?? []).map((criterion) => ({
          criterionId: criterion.criterionId,
          passed: criterion.passed,
          evaluated: criterion.evaluated,
          ...(content.evaluationDetails ? { feedback: criterion.feedback } : {}),
        })),
        ...(content.evaluationDetails ? { judgeFeedback: turn.judgeFeedback } : {}),
        ...(content.conversations ? { codingAgentResponse: turn.codingAgentResponse } : {}),
        ...(content.conversations && content.prompts && content.evaluationDetails ? {
          toolCalls: turn.toolCalls?.map((call) => ({
            name: call.name, arguments: call.arguments, response: call.response,
          })),
        } : {}),
      })),
    },
    ...(content.prompts ? { prompts: prompts ?? [] } : {}),
    artifacts: sharedArtifacts(share, run).map(({ id, label, category, contentType }) => ({
      id, label, category, contentType,
    })),
  };
}
