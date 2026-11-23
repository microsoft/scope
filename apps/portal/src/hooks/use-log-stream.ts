// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useEffect, useMemo, useState, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useSelectedProjectId } from "@/contexts/ProjectContext";
import { api } from "@/lib/api";
import { openLogStream, readLogStream } from "@/lib/log-stream";
import type { LogEvent } from "@/types";

interface UseLogStreamOptions {
  /** Run ID to stream logs for */
  id: string;
  /** Whether the stream is enabled (default: true) */
  enabled?: boolean;
  /** Start from the beginning (default: true) */
  fromStart?: boolean;
  /** Attempt number — used to detect when a new attempt is created and reconnect (default: undefined) */
  attemptNumber?: number;
  /** Custom URL builder (default: api.logsUrl). Use api.reportLogsUrl for reports. */
  urlBuilder?: (id: string, fromStart: boolean) => string;
}

interface StreamState {
  logs: LogEvent[];
  isConnected: boolean;
  isDone: boolean;
  error: string | null;
}

interface UseLogStreamReturn extends StreamState {
  clear: () => void;
}

const EMPTY: StreamState = { logs: [], isConnected: false, isDone: false, error: null };

export function useLogStream({
  id,
  enabled = true,
  fromStart = true,
  attemptNumber,
  urlBuilder = api.logsUrl,
}: UseLogStreamOptions): UseLogStreamReturn {
  const { account, user, isReady } = useAuth();
  const projectId = useSelectedProjectId();
  const identity = useMemo(() => ({
    id, enabled, fromStart, attemptNumber, urlBuilder, isReady, projectId,
  }), [
    id, enabled, fromStart, attemptNumber, urlBuilder, isReady, projectId,
    user?.id, account?.homeAccountId, account?.localAccountId, account?.tenantId, account?.environment,
  ]);
  const [snapshot, setSnapshot] = useState<(StreamState & { identity: typeof identity }) | null>(null);

  const clear = useCallback(() => {
    setSnapshot((previous) => previous?.identity === identity ? { ...previous, logs: [] } : previous);
  }, [identity]);

  useEffect(() => {
    const projectId = identity.projectId;
    if (!identity.enabled || !identity.id || !identity.isReady || !projectId) return;
    const controller = new AbortController();
    setSnapshot({ identity, ...EMPTY });
    const update = (change: (state: StreamState) => Partial<StreamState>) => {
      if (controller.signal.aborted) return;
      setSnapshot((previous) => previous?.identity === identity
        ? { ...previous, ...change(previous) }
        : previous);
    };
    void (async () => {
      try {
        const url = new URL(identity.urlBuilder(identity.id, identity.fromStart), window.location.href);
        url.searchParams.set("projectId", projectId);
        const response = await openLogStream(url.toString(), controller.signal);
        update(() => ({ isConnected: true, error: null }));
        await readLogStream(response, controller.signal, (event) => {
          if (event.type === "log") update((state) => ({ logs: [...state.logs, event.log] }));
          else if (event.type === "done") update(() => ({ isDone: true, isConnected: false }));
          else update(() => ({
            error: event.type === "timeout" ? "Stream timed out" : event.message,
            isConnected: false,
          }));
        });
      } catch (cause) {
        if (controller.signal.aborted) return;
        update(() => ({
          isConnected: false,
          error: cause instanceof Error ? cause.message : "Unable to connect to log stream.",
        }));
      }
    })();
    return () => controller.abort();
  }, [identity]);

  // Hide the previous identity's logs during render, before effect cleanup can run.
  const state = snapshot?.identity === identity ? snapshot : EMPTY;
  return { logs: state.logs, isConnected: state.isConnected, isDone: state.isDone, error: state.error, clear };
}
