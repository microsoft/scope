// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { CopilotSession, SessionEvent } from "@github/copilot-sdk";

/** Minimal SDK session surface required for one guarded completion. */
type Session = Pick<CopilotSession, "on" | "sendAndWait" | "abort" | "disconnect" | "sessionId">;

/**
 * Submits once and always attempts session cleanup.
 * Cancellation and cleanup failures are reported alongside inference errors.
 *
 * @param session - Isolated SDK session with no tools or ambient configuration.
 * @param prompt - Model-visible user prompt text.
 * @param deleteSession - Removes persisted SDK session data after disconnect.
 * @param signal - Optional caller cancellation signal.
 * @param timeoutMs - Request deadline in milliseconds; defaults to 120000.
 * @returns Assistant text and SDK usage when exposed.
 */
export async function executeSdkCall(
  session: Session,
  prompt: string,
  deleteSession: () => Promise<void>,
  signal?: AbortSignal,
  timeoutMs = 120_000,
): Promise<{ content: string; usage?: Record<string, unknown> }> {
  const usages: Record<string, unknown>[] = [];
  let attempts = 0;
  let primaryError: unknown;
  let output: { content: string; usage?: Record<string, unknown> } | undefined;
  const cleanupErrors: unknown[] = [];
  const pendingAborts: Promise<void>[] = [];

  // Queue aborts so cleanup can wait for every attempt without hiding abort failures.
  const abortSession = () => {
    pendingAborts.push(session.abort().catch(error => {
      cleanupErrors.push(error);
    }));
  };

  const unsubscribe = session.on((event: SessionEvent) => {
    // Usage and failure events enforce the one-model-attempt contract.
    if (event.type === "assistant.usage") {
      attempts++;
      const usage = event.data;
      usages.push({
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        reasoningTokens: usage.reasoningTokens,
        cost: usage.cost,
        duration: usage.duration,
      });
    }

    if (event.type === "model.call_failure") {
      attempts++;
      abortSession();
    }
  });

  let removeAbortListener: () => void = () => { };
  let stopReason: Error | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // Resolve rather than reject so the timeout/cancellation race is safely observed.
  const stopped = new Promise<Error>(resolve => {
    const onAbort = () => {
      stopReason = new Error("Copilot SDK request cancelled");
      abortSession();
      resolve(stopReason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal?.removeEventListener("abort", onAbort);
    timer = setTimeout(
      () => {
        stopReason = new Error(`Copilot SDK request timed out after ${timeoutMs}ms`);
        abortSession();
        resolve(stopReason);
      },
      timeoutMs
    );
  });

  try {
    if (signal?.aborted) {
      throw new Error("Copilot SDK request cancelled before submission");
    }

    // Cancellation and timeout explicitly abort the server-side session.
    const response = await Promise.race([
      session.sendAndWait({ prompt }, timeoutMs),
      stopped.then(error => {
        throw error;
      }),
    ]);
    if (!response?.data.content) {
      throw new Error("Copilot SDK returned no assistant content");
    }
    if (attempts > 1) {
      throw new Error("SDK emitted more than one model attempt; single-call contract violated");
    }

    output = { content: response.data.content, usage: usages[0] };
  } catch (error) {
    primaryError = error;
    abortSession();
  } finally {
    // Both cleanup paths run independently, even after the primary failure.
    clearTimeout(timer);
    removeAbortListener();
    await Promise.all(pendingAborts);
    unsubscribe();

    for (const cleanup of [() => session.disconnect(), deleteSession]) {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }

  if (primaryError && !cleanupErrors.length) {
    throw primaryError;
  }
  if (primaryError || cleanupErrors.length) {
    throw new AggregateError([...(primaryError ? [primaryError] : []), ...cleanupErrors], "Copilot SDK invocation/cleanup failed");
  }
  if (!output) {
    throw new Error("Copilot SDK returned no result");
  }

  return output;
}
