// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  decodeWebSocketMessages,
  formatWebSocketPayload,
  summarizeWebSocketMessages,
  type HarWebSocketMessage,
} from "@/lib/har-websocket";

/** Which messages the direction filter shows. */
type DirectionFilter = "all" | "send" | "receive";

const FILTER_LABELS: Record<DirectionFilter, string> = {
  all: "All",
  send: "Sent",
  receive: "Received",
};

interface HarWebSocketMessagesProps {
  /** Messages recorded on the connection (the entry's `_webSocketMessages`). */
  messages: HarWebSocketMessage[];
}

/** Format a byte count compactly (B / KB / MB). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Format an offset from the first message, e.g. `+1.250 s`. */
function formatOffset(ms: number): string {
  return `+${(ms / 1000).toFixed(3)} s`;
}

/**
 * Frame-by-frame view of one WebSocket connection, in the style of the
 * browser DevTools "Messages" tab: direction, time since the first frame,
 * payload size and the payload itself (pretty-printed when it is JSON).
 */
export function HarWebSocketMessages({ messages }: HarWebSocketMessagesProps) {
  const [filter, setFilter] = useState<DirectionFilter>("all");

  const decoded = useMemo(() => decodeWebSocketMessages(messages), [messages]);
  const summary = useMemo(() => summarizeWebSocketMessages(decoded), [decoded]);
  const visible = filter === "all" ? decoded : decoded.filter((m) => m.direction === filter);

  if (decoded.length === 0) {
    return <div className="text-muted-foreground italic">No messages recorded</div>;
  }

  return (
    <div className="space-y-2">
      {/* Summary + direction filter */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-muted-foreground">
          {summary.sent} sent · {summary.received} received · {formatBytes(summary.totalBytes)}
        </span>
        <div className="flex-1" />
        <div role="group" aria-label="Filter messages by direction" className="flex rounded-md border">
          {(Object.keys(FILTER_LABELS) as DirectionFilter[]).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
              className={cn(
                "px-2 py-0.5 transition-colors first:rounded-l-md last:rounded-r-md",
                filter === key ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {FILTER_LABELS[key]}
            </button>
          ))}
        </div>
      </div>

      {/* Message list */}
      <ol className="space-y-1.5" aria-label="WebSocket messages">
        {visible.map((msg, idx) => (
          <li
            key={idx}
            className={cn(
              "rounded border-l-2 bg-muted/30 p-2",
              msg.direction === "send" ? "border-l-emerald-500" : "border-l-blue-500",
            )}
          >
            <div className="mb-1 flex items-center gap-2 text-muted-foreground">
              {msg.direction === "send" ? (
                <ArrowUp className="h-3 w-3 text-emerald-600" aria-hidden="true" />
              ) : (
                <ArrowDown className="h-3 w-3 text-blue-600" aria-hidden="true" />
              )}
              <span className="font-medium text-foreground">
                {msg.direction === "send" ? "Sent" : "Received"}
              </span>
              <span className="tabular-nums">{formatOffset(msg.offsetMs)}</span>
              <span className="tabular-nums">{formatBytes(msg.sizeBytes)}</span>
              {msg.isBinary && (
                <span className="rounded bg-muted px-1 font-mono text-[10px]">
                  {msg.isBase64 ? "binary · base64" : "binary"}
                </span>
              )}
            </div>
            <pre className="max-h-[300px] overflow-y-auto whitespace-pre-wrap break-all font-mono">
              {msg.isBase64 ? msg.text : formatWebSocketPayload(msg.text)}
            </pre>
          </li>
        ))}
      </ol>
    </div>
  );
}
