// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useQuery, useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "@/lib/api";
import { apiClient } from "@/lib/api-client";
import type { ConversationTurn } from "@/types";
import {
  extractFromHar,
  type ConversationSegment,
  type HarExtractedData,
  type HarFile,
  type ToolCall,
} from "@/lib/har-extraction";

export type { ConversationSegment, HarExtractedData, ToolCall };

// ---------------------------------------------------------------------------
// Shared HAR data hook — single source of truth for fetching HAR JSON.
// All tabs (Conversation, Network, Tool Calls) share this cache.
// Generic so each consumer can use their own HAR type definition.
// ---------------------------------------------------------------------------
export function useHarData<T = unknown>(runId: string, iteration?: number, enabled = true, attemptRunId?: string) {
  return useQuery<T>({
    queryKey: ["har", runId, iteration, attemptRunId],
    queryFn: async () => {
      const url = attemptRunId ? api.runHarUrl(runId, attemptRunId, iteration) : api.harUrl(runId, iteration);
      const res = await apiClient(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled,
    staleTime: Infinity, // HAR data is immutable once created
  });
}

// ---------------------------------------------------------------------------
// React hook: fetch HAR for a turn and extract thinking + tool calls
// ---------------------------------------------------------------------------
export function useHarExtraction(runId: string, iteration?: number, hasHar?: boolean, attemptRunId?: string): {
  data: HarExtractedData | undefined;
  isLoading: boolean;
} {
  const { data: har, isLoading } = useHarData<HarFile>(runId, iteration, !!hasHar, attemptRunId);

  const data = useMemo(() => {
    if (!har) return undefined;
    return extractFromHar(har);
  }, [har]);

  return { data, isLoading };
}

// ---------------------------------------------------------------------------
// React hook: fetch server-extracted tool calls for all turns
// ---------------------------------------------------------------------------
export interface AggregatedToolCall extends ToolCall {
  _iteration?: number;
}

export function useAllTurnsToolCalls(
  runId: string,
  turns?: ConversationTurn[],
  attemptRunId?: string,
): { allToolCalls: AggregatedToolCall[]; isLoading: boolean } {
  // Per-iteration tool-calls.jsonl is the source for the Tool Calls tab.
  const jsonlQueries = useMemo(() => {
    const q: { iteration: number }[] = [];
    if (turns) {
      for (const t of turns) {
        if (t.toolCallsUrl) {
          q.push({ iteration: t.iteration });
        }
      }
    }
    return q;
  }, [turns]);

  const jsonlResults = useQueries({
    queries: jsonlQueries.map((q) => ({
      queryKey: ["tool-calls", runId, q.iteration, attemptRunId],
      queryFn: async () => {
        const url = attemptRunId ? api.runToolCallsUrl(runId, attemptRunId, q.iteration) : api.toolCallsUrl(runId, q.iteration);
        const res = await apiClient(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        return text
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as ToolCall);
      },
      staleTime: Infinity,
    })),
  });

  const allToolCalls = useMemo(() => {
    const out: AggregatedToolCall[] = [];
    for (let i = 0; i < jsonlResults.length; i++) {
      const tcs = jsonlResults[i].data;
      if (!tcs) continue;
      const iteration = jsonlQueries[i].iteration;
      for (const tc of tcs) {
        out.push({ ...tc, timestamp: tc.timestamp ?? "", _iteration: iteration });
      }
    }
    return out;
  }, [jsonlResults, jsonlQueries]);

  const isLoading = jsonlResults.some((r) => r.isLoading);

  return { allToolCalls, isLoading };
}
