// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import {
  decodeWebSocketMessages,
  formatWebSocketPayload,
  getWebSocketMessages,
  summarizeWebSocketMessages,
  type HarWebSocketMessage,
} from "./har-websocket";

/** Base64-encode raw bytes the way the gateway does for binary frames. */
function toBase64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

describe("getWebSocketMessages", () => {
  it("returns an empty array for a plain HTTP entry", () => {
    expect(getWebSocketMessages({})).toEqual([]);
    expect(getWebSocketMessages({ _webSocketMessages: "nope" })).toEqual([]);
  });

  it("keeps well-formed messages and drops malformed ones", () => {
    const good: HarWebSocketMessage = { type: "send", time: 1, opcode: 1, data: "hi" };
    const messages = getWebSocketMessages({
      _webSocketMessages: [good, null, { type: "receive" }, 42],
    });
    expect(messages).toEqual([good]);
  });
});

describe("decodeWebSocketMessages", () => {
  it("normalises direction and measures offsets from the first message", () => {
    const decoded = decodeWebSocketMessages([
      { type: "send", time: 1000.5, opcode: 1, data: "a" },
      { type: "receive", time: 1001.75, opcode: 1, data: "b" },
      { type: "weird", time: 1002, opcode: 1, data: "c" },
    ]);

    expect(decoded.map((m) => m.direction)).toEqual(["send", "receive", "receive"]);
    expect(decoded.map((m) => m.offsetMs)).toEqual([0, 1250, 1500]);
  });

  it("reports UTF-8 byte size for text frames", () => {
    const [msg] = decodeWebSocketMessages([{ type: "send", time: 0, opcode: 1, data: "héllo" }]);
    expect(msg.isBinary).toBe(false);
    expect(msg.text).toBe("héllo");
    expect(msg.sizeBytes).toBe(6);
  });

  it("decodes binary frames that hold valid UTF-8", () => {
    const data = toBase64([...new TextEncoder().encode('{"ok":true}')]);
    const [msg] = decodeWebSocketMessages([{ type: "receive", time: 0, opcode: 2, data }]);
    expect(msg).toMatchObject({ isBinary: true, isBase64: false, text: '{"ok":true}', sizeBytes: 11 });
  });

  it("keeps non-text binary frames as base64", () => {
    const data = toBase64([0xff, 0xfe, 0x00, 0x81]);
    const [msg] = decodeWebSocketMessages([{ type: "receive", time: 0, opcode: 2, data }]);
    expect(msg).toMatchObject({ isBinary: true, isBase64: true, text: data, sizeBytes: 4 });
  });

  it("does not throw on an invalid base64 payload", () => {
    const [msg] = decodeWebSocketMessages([{ type: "receive", time: 0, opcode: 2, data: "%%%" }]);
    expect(msg).toMatchObject({ isBinary: true, isBase64: true, text: "%%%", sizeBytes: 0 });
  });
});

describe("summarizeWebSocketMessages", () => {
  it("counts each direction and totals payload bytes", () => {
    const decoded = decodeWebSocketMessages([
      { type: "send", time: 0, opcode: 1, data: "abc" },
      { type: "receive", time: 1, opcode: 1, data: "de" },
      { type: "receive", time: 2, opcode: 1, data: "f" },
    ]);
    expect(summarizeWebSocketMessages(decoded)).toEqual({ sent: 1, received: 2, totalBytes: 6 });
  });
});

describe("formatWebSocketPayload", () => {
  it("pretty-prints JSON payloads", () => {
    expect(formatWebSocketPayload('{"a":1}')).toBe('{\n  "a": 1\n}');
  });

  it("returns non-JSON payloads unchanged", () => {
    expect(formatWebSocketPayload("ping")).toBe("ping");
    expect(formatWebSocketPayload("{not json")).toBe("{not json");
  });
});
