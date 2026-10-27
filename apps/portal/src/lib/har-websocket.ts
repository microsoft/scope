// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Helpers for WebSocket exchanges recorded in a HAR file.
 *
 * HAR 1.2 has no WebSocket model, so recorders follow the Chrome DevTools
 * convention: one entry per connection (the `101 Switching Protocols`
 * upgrade handshake) carrying a `_webSocketMessages` array. The Scope
 * gateway writes this shape (see `apps/gateway/src/proxy/websocket.rs`).
 */

/** WebSocket opcode for a text frame. */
export const WS_OPCODE_TEXT = 1;
/** WebSocket opcode for a binary frame. */
export const WS_OPCODE_BINARY = 2;

/** One recorded frame, as stored in `_webSocketMessages`. */
export interface HarWebSocketMessage {
  /** Direction: `"send"` (client → server) or `"receive"` (server → client). */
  type: string;
  /** Unix timestamp in seconds, with millisecond precision. */
  time: number;
  /** Frame opcode: 1 = text, 2 = binary (base64-encoded `data`). */
  opcode: number;
  /** Payload: plain text for opcode 1, base64 for opcode 2. */
  data: string;
}

/** A message prepared for display. */
export interface DecodedWebSocketMessage {
  /** Normalised direction; anything other than `"send"` is treated as received. */
  direction: "send" | "receive";
  /** Milliseconds since the first message on the connection (0 for the first). */
  offsetMs: number;
  /** True for binary frames (opcode 2). */
  isBinary: boolean;
  /**
   * Text to show. Text frames are shown as-is; binary frames are decoded as
   * UTF-8 when valid, otherwise left as their base64 payload.
   */
  text: string;
  /** True when a binary frame could not be decoded and `text` is base64. */
  isBase64: boolean;
  /** Payload size in bytes (UTF-8 length for text, decoded length for binary). */
  sizeBytes: number;
}

/** Message counts and total payload size for a connection. */
export interface WebSocketSummary {
  sent: number;
  received: number;
  totalBytes: number;
}

/** True when `value` looks like a recorded WebSocket message. */
function isHarWebSocketMessage(value: unknown): value is HarWebSocketMessage {
  if (!value || typeof value !== "object") return false;
  const msg = value as Record<string, unknown>;
  return typeof msg.type === "string" && typeof msg.data === "string";
}

/**
 * Return the entry's recorded WebSocket messages, or an empty array when the
 * entry is not a WebSocket connection. Malformed items are dropped so one bad
 * frame never breaks the viewer.
 */
export function getWebSocketMessages(entry: { _webSocketMessages?: unknown }): HarWebSocketMessage[] {
  const raw = entry._webSocketMessages;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isHarWebSocketMessage);
}

/** Decode a base64 string to bytes, or `null` when it is not valid base64. */
function base64ToBytes(data: string): Uint8Array | null {
  try {
    const binary = atob(data);
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Decode one message's payload into display text plus its byte size. */
function decodePayload(msg: HarWebSocketMessage): Pick<DecodedWebSocketMessage, "isBinary" | "text" | "isBase64" | "sizeBytes"> {
  if (msg.opcode !== WS_OPCODE_BINARY) {
    return {
      isBinary: false,
      text: msg.data,
      isBase64: false,
      sizeBytes: new TextEncoder().encode(msg.data).length,
    };
  }

  const bytes = base64ToBytes(msg.data);
  if (!bytes) {
    return { isBinary: true, text: msg.data, isBase64: true, sizeBytes: 0 };
  }

  // Many "binary" frames are UTF-8 text in practice; show them readably when
  // they decode cleanly and fall back to the raw base64 otherwise.
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { isBinary: true, text, isBase64: false, sizeBytes: bytes.length };
  } catch {
    return { isBinary: true, text: msg.data, isBase64: true, sizeBytes: bytes.length };
  }
}

/**
 * Prepare a connection's messages for display, keeping recorded order and
 * expressing each timestamp as an offset from the first message.
 */
export function decodeWebSocketMessages(messages: HarWebSocketMessage[]): DecodedWebSocketMessage[] {
  const firstTime = messages.find((m) => Number.isFinite(m.time))?.time;

  return messages.map((msg) => ({
    direction: msg.type === "send" ? "send" : "receive",
    offsetMs:
      firstTime !== undefined && Number.isFinite(msg.time)
        ? Math.max(0, Math.round((msg.time - firstTime) * 1000))
        : 0,
    ...decodePayload(msg),
  }));
}

/** Count sent and received messages and add up their payload sizes. */
export function summarizeWebSocketMessages(messages: DecodedWebSocketMessage[]): WebSocketSummary {
  let sent = 0;
  let received = 0;
  let totalBytes = 0;

  for (const msg of messages) {
    if (msg.direction === "send") sent++;
    else received++;
    totalBytes += msg.sizeBytes;
  }

  return { sent, received, totalBytes };
}

/**
 * Pretty-print a payload when it is JSON; otherwise return it unchanged.
 * WebSocket protocols commonly exchange one JSON document per frame.
 */
export function formatWebSocketPayload(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;

  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}
