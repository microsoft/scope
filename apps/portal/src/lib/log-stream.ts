// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createParser } from "eventsource-parser";
import { isNetworkError } from "ky";
import { apiClient } from "./api-client";
import type { LogEvent } from "@/types";

export type LogStreamEvent =
  | { type: "log"; log: LogEvent }
  | { type: "done" }
  | { type: "timeout" }
  | { type: "error"; message: string };

const DISCONNECTED = "Log stream disconnected. Reload to replay stored logs.";
const MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLogEvent(value: unknown): value is LogEvent {
  return isRecord(value)
    && typeof value.timestamp === "string"
    && Number.isFinite(Date.parse(value.timestamp))
    && typeof value.message === "string"
    && typeof value.level === "string"
    && ["info", "warn", "error", "debug"].includes(value.level)
    && (value.source === undefined || typeof value.source === "string")
    && (value.data === undefined || isRecord(value.data));
}

function retryDelay(response: Response | undefined, attempt: number): number | undefined {
  const header = response?.headers.get("Retry-After");
  if (header) {
    const seconds = Number(header);
    const delay = Number.isFinite(seconds) && seconds >= 0
      ? seconds * 1_000
      : Date.parse(header) - Date.now();
    if (Number.isFinite(delay)) {
      // Do not retry earlier than requested when the server exceeds our wait budget.
      return delay > MAX_RETRY_DELAY_MS ? undefined : Math.max(0, delay);
    }
  }
  return 500 * 2 ** attempt + Math.random() * 250;
}

function waitForRetry(delay: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delay);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Retry only before accepting a stream: the server has no replay/resume cursor. */
export async function openLogStream(url: string, signal: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await apiClient.get(url, {
        signal,
        headers: { Accept: "text/event-stream" },
        cache: "no-store",
      });
    } catch (error) {
      signal.throwIfAborted();
      if (!isNetworkError(error) || attempt >= MAX_RETRIES) throw error;
      const delay = retryDelay(undefined, attempt);
      if (delay === undefined) throw error;
      await waitForRetry(delay, signal);
      continue;
    }
    signal.throwIfAborted();
    if (!response.ok) {
      const error = new Error(`Log stream request failed (HTTP ${response.status}).`);
      const transient = response.status === 429 || [500, 502, 503, 504].includes(response.status);
      const delay = retryDelay(response, attempt);
      await response.body?.cancel();
      if (!transient || attempt >= MAX_RETRIES || delay === undefined) throw error;
      await waitForRetry(delay, signal);
      continue;
    }
    if (response.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "text/event-stream") {
      await response.body?.cancel();
      throw new Error("Expected a text/event-stream response for logs.");
    }
    if (!response.body) throw new Error("Log stream response has no body.");
    return response;
  }
}

export async function readLogStream(
  response: Response,
  signal: AbortSignal,
  onEvent: (event: LogStreamEvent) => void,
): Promise<void> {
  if (!response.body) throw new Error("Log stream response has no body.");
  signal.throwIfAborted();
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {
      console.warn("Unable to cancel closed log stream reader.");
    });
  };
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let terminal = false;
  let trailingCR = false;
  const parser = createParser({
    onEvent(event) {
      if (terminal || signal.aborted) return;
      const type = event.event || "message";
      if (type === "done" || type === "timeout") {
        terminal = true;
        onEvent({ type });
        return;
      }
      if (type !== "message" && type !== "error") return;
      let value: unknown;
      try {
        value = JSON.parse(event.data);
      } catch {
        throw new Error("Invalid JSON in log stream event.");
      }
      if (type === "error") {
        if (!isRecord(value) || typeof value.message !== "string" || !value.message) {
          throw new Error("Invalid log stream error event.");
        }
        terminal = true;
        onEvent({ type: "error", message: value.message });
      } else if (isLogEvent(value)) {
        onEvent({ type: "log", log: value });
      } else if (!isRecord(value) || value.type !== "turns_summary") {
        throw new Error("Invalid log entry received from server.");
      }
    },
  });
  try {
    while (!terminal) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) {
        decoder.decode();
        // Resolve the parser's deferred trailing CR, without inventing an EOF event.
        if (trailingCR) parser.feed("\n");
        if (!terminal) throw new Error(DISCONNECTED);
        break;
      }
      const text = decoder.decode(value, { stream: true });
      if (text) trailingCR = text.endsWith("\r");
      parser.feed(text);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}
