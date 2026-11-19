// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { ConversationTurn } from "@/types";
import { api } from "@/lib/api";
import { apiClient } from "@/lib/api-client";
import { useAllTurnsToolCalls } from "./useHarExtraction";

vi.mock("@/lib/api", () => ({
  api: {
    toolCallsUrl: vi.fn(() => "/api/v1/requests/request-1/tool-calls?iteration=1"),
    runToolCallsUrl: vi.fn(() => "/api/v1/requests/request-1/runs/attempt-1/tool-calls?iteration=1"),
  },
}));
vi.mock("@/lib/api-client", () => ({ apiClient: vi.fn() }));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useAllTurnsToolCalls", () => {
  it("reads only the JSONL artifact for a historical attempt", async () => {
    const turns = [{
      iteration: 1,
      toolCallsUrl: "https://blob/tool-calls.jsonl",
      harUrl: "https://blob/run.har",
      toolCalls: [{ id: "old", name: "legacy", arguments: {} }],
    }] as ConversationTurn[];
    vi.mocked(apiClient).mockResolvedValue({
      ok: true,
      text: async () => '{"id":"new","name":"read_file","arguments":{}}\n',
    } as Response);

    const { result } = renderHook(() => useAllTurnsToolCalls("request-1", turns, "attempt-1"), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.allToolCalls).toEqual([{
      id: "new", name: "read_file", arguments: {}, timestamp: "", _iteration: 1,
    }]);
    expect(api.runToolCallsUrl).toHaveBeenCalledWith("request-1", "attempt-1", 1);
    expect(apiClient).toHaveBeenCalledTimes(1);
  });

  it("does not fetch a HAR for turns without a tool-calls artifact", () => {
    const turns = [{ iteration: 1, harUrl: "https://blob/run.har" }] as ConversationTurn[];

    const { result } = renderHook(() => useAllTurnsToolCalls("request-1", turns), { wrapper });

    expect(result.current.allToolCalls).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(apiClient).not.toHaveBeenCalled();
  });
});
