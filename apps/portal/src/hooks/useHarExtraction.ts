// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useQuery, useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "@/lib/api";
import { fetchArtifact } from "@/lib/artifact-delivery";
import { useArtifactSession } from "./use-artifact-session";
import type { ConversationTurn } from "@/types";
import {
  extractChronologicalSegments,
  extractFromHar,
  type ConversationSegment,
  type HarExtractedData,
  type HarFile,
  type ToolCall,
} from "@/lib/har-extraction";

export type { ConversationSegment, HarExtractedData, ToolCall };

async function readHar<T>(url: string, projectId: string, signal: AbortSignal): Promise<T> {
  const response = await fetchArtifact(url, projectId, signal);
  const data: T = await response.json();
  signal.throwIfAborted();
  if (!data || typeof data !== "object" || !("log" in data) || !data.log ||
      typeof data.log !== "object" || !("entries" in data.log) || !Array.isArray(data.log.entries)) {
    throw new Error("The server returned an invalid HAR file.");
  }
  return data;
}

function parseToolCall(line: string): ToolCall {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string" ||
      !("name" in value) || typeof value.name !== "string" ||
      !("arguments" in value) || !value.arguments || typeof value.arguments !== "object" ||
      Array.isArray(value.arguments) ||
      ("timestamp" in value && typeof value.timestamp !== "string") ||
      ("response" in value && typeof value.response !== "string")) {
    throw new Error("The server returned an invalid tool-call record.");
  }
  return {
    id: value.id, name: value.name, arguments: value.arguments as Record<string, unknown>,
    timestamp: "timestamp" in value ? value.timestamp as string : "",
    ...("response" in value ? { response: value.response as string } : {}),
  };
}

// ---------------------------------------------------------------------------
// Shared HAR data hook — single source of truth for fetching HAR JSON.
// All tabs (Conversation, Network, Tool Calls) share this cache.
// Generic so each consumer can use their own HAR type definition.
// ---------------------------------------------------------------------------
export function useHarData<T = unknown>(runId: string, iteration?: number, enabled = true, attemptRunId?: string) {
  const session = useArtifactSession(`${runId}/${attemptRunId ?? "latest"}`);
  const result = useQuery<T>({
    queryKey: ["har", runId, iteration, attemptRunId, session.key],
    queryFn: async ({ signal }) => {
      const url = attemptRunId ? api.runHarUrl(runId, attemptRunId, iteration) : api.harUrl(runId, iteration);
      return readHar<T>(url, session.projectId!, AbortSignal.any([signal, session.controller.signal]));
    },
    enabled: enabled && session.ready,
    retry: false,
    staleTime: Infinity, // HAR data is immutable once created
  });
  return { ...result, data: session.ready ? result.data : undefined };
}

// ---------------------------------------------------------------------------
// React hook: fetch HAR for a turn and extract thinking + tool calls
// ---------------------------------------------------------------------------
export function useHarExtraction(runId: string, iteration?: number, hasHar?: boolean, attemptRunId?: string): {
  data: HarExtractedData | undefined;
  isLoading: boolean;
  error: Error | null;
} {
  const { data: har, isLoading, error } = useHarData<HarFile>(runId, iteration, !!hasHar, attemptRunId);

  const data = useMemo(() => {
    if (!har) return undefined;
    return extractFromHar(har);
  }, [har]);

  return { data, isLoading, error };
}

// ---------------------------------------------------------------------------
// React hook: fetch HARs for ALL turns and aggregate tool calls
// ---------------------------------------------------------------------------
export interface AggregatedToolCall extends ToolCall {
  _iteration?: number;
}

export function useAllTurnsToolCalls(
  runId: string,
  turns?: ConversationTurn[],
  topLevelHarUrl?: string,
  attemptRunId?: string,
): { allToolCalls: AggregatedToolCall[]; isLoading: boolean; error: Error | null } {
  const session = useArtifactSession(`${runId}/${attemptRunId ?? "latest"}`);
  // Turns that already have pre-computed `toolCalls` (legacy inline shape)
  // don't need any blob fetch.
  const preComputed = useMemo(() => {
    const out: AggregatedToolCall[] = [];
    if (turns) {
      for (const t of turns) {
        if (t.toolCalls && t.toolCalls.length > 0) {
          for (const tc of t.toolCalls) {
            out.push({ ...tc, timestamp: tc.timestamp ?? "", _iteration: t.iteration });
          }
        }
      }
    }
    return out;
  }, [turns]);

  // New shape: per-iteration tool-calls.jsonl in blob storage. Fetched via
  // the API proxy (`/api/v1/requests/:id/tool-calls?iteration=N`) and parsed
  // line-by-line. Preferred over re-extracting from the HAR.
  const jsonlQueries = useMemo(() => {
    const q: { iteration: number }[] = [];
    if (turns) {
      for (const t of turns) {
        const hasInline = t.toolCalls && t.toolCalls.length > 0;
        if (!hasInline && t.toolCallsUrl) {
          q.push({ iteration: t.iteration });
        }
      }
    }
    return q;
  }, [turns]);

  const jsonlResults = useQueries({
    queries: jsonlQueries.map((q) => ({
      queryKey: ["tool-calls", runId, q.iteration, attemptRunId, session.key],
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        const url = attemptRunId ? api.runToolCallsUrl(runId, attemptRunId, q.iteration) : api.toolCallsUrl(runId, q.iteration);
        const scopedSignal = AbortSignal.any([signal, session.controller.signal]);
        const res = await fetchArtifact(url, session.projectId!, scopedSignal);
        const text = await res.text();
        scopedSignal.throwIfAborted();
        return text
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map(parseToolCall);
      },
      enabled: session.ready,
      retry: false,
      staleTime: Infinity,
    })),
  });

  // Legacy fallback: turns that have `harUrl` but neither inline `toolCalls`
  // nor a `toolCallsUrl` blob — re-extract from the HAR.
  const queries = useMemo(() => {
    const q: { iteration: number | undefined; enabled: boolean }[] = [];

    // One-shot run: top-level HAR, no iteration
    if (topLevelHarUrl && (!turns || turns.length === 0)) {
      q.push({ iteration: undefined, enabled: true });
    }

    // Multi-turn: one query per turn with harUrl but WITHOUT pre-computed
    // toolCalls and WITHOUT a tool-calls JSONL blob.
    if (turns) {
      for (const t of turns) {
        const hasInline = t.toolCalls && t.toolCalls.length > 0;
        const hasJsonl = !!t.toolCallsUrl;
        if (t.harUrl && !hasInline && !hasJsonl) {
          q.push({ iteration: t.iteration, enabled: true });
        }
      }
    }

    return q;
  }, [turns, topLevelHarUrl]);

  const results = useQueries({
    queries: queries.map((q) => ({
      queryKey: ["har", runId, q.iteration, attemptRunId, session.key],
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        const url = attemptRunId ? api.runHarUrl(runId, attemptRunId, q.iteration) : api.harUrl(runId, q.iteration);
        return readHar<HarFile>(url, session.projectId!, AbortSignal.any([signal, session.controller.signal]));
      },
      enabled: q.enabled && session.ready,
      retry: false,
      staleTime: Infinity,
    })),
  });

  const allToolCalls = useMemo(() => {
    const out: AggregatedToolCall[] = [...preComputed];
    // JSONL blob fetches first
    for (let i = 0; i < jsonlResults.length; i++) {
      const tcs = jsonlResults[i].data;
      if (!tcs) continue;
      const iteration = jsonlQueries[i].iteration;
      for (const tc of tcs) {
        out.push({ ...tc, timestamp: tc.timestamp ?? "", _iteration: iteration });
      }
    }
    // Legacy HAR re-extraction
    for (let i = 0; i < results.length; i++) {
      const har = results[i].data;
      if (!har) continue;
      const segments = extractChronologicalSegments(har);
      const tcs = segments
        .filter((s): s is ConversationSegment & { type: "tool_calls" } => s.type === "tool_calls")
        .flatMap((s) => s.toolCalls);
      const iteration = queries[i].iteration;
      for (const tc of tcs) {
        out.push({ ...tc, _iteration: iteration });
      }
    }
    return out;
  }, [preComputed, jsonlResults, jsonlQueries, results, queries]);

  const isLoading = results.some((r) => r.isLoading) || jsonlResults.some((r) => r.isLoading);

  const error = [...jsonlResults, ...results].find(result => result.error)?.error ?? null;
  return { allToolCalls: session.ready ? allToolCalls : [], isLoading, error };
}
