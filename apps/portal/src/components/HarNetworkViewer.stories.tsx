// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import { HarNetworkViewer } from "./HarNetworkViewer";

const base = new Date("2026-06-21T12:00:00Z").getTime();
const methods = ["GET", "POST", "GET", "PUT", "GET", "DELETE"];

// Enough rows that the table is much taller than the viewport, plus a large
// JSON body so the detail panel's own content has to scroll.
const sampleHar = {
  log: {
    entries: Array.from({ length: 60 }, (_, i) => ({
      startedDateTime: new Date(base + i * 250).toISOString(),
      time: 40 + ((i * 37) % 900),
      request: {
        method: methods[i % methods.length],
        url: `https://api.example.com/v1/items/${i}?page=${i % 5}`,
        headers: [
          { name: "accept", value: "application/json" },
          { name: "user-agent", value: "scope-worker/1.0" },
        ],
        ...(i % 2 === 1 && {
          postData: { mimeType: "application/json", text: JSON.stringify({ id: i, name: `item-${i}` }) },
        }),
      },
      response: {
        status: i % 13 === 0 ? 500 : i % 7 === 0 ? 404 : 200,
        statusText: i % 13 === 0 ? "Internal Server Error" : i % 7 === 0 ? "Not Found" : "OK",
        headers: Array.from({ length: 12 }, (_, h) => ({ name: `x-header-${h}`, value: `value-${i}-${h}` })),
        content: {
          size: 512 + i * 128,
          mimeType: "application/json",
          text: JSON.stringify({ id: i, items: Array.from({ length: 40 }, (_, n) => ({ n, label: `row ${n}` })) }),
        },
      },
    })),
  },
};

const harHandler = http.get("*/api/v1/requests/:id/har", () => HttpResponse.json(sampleHar));

// A HAR mixing plain HTTP calls with one WebSocket connection recorded the way
// the gateway writes it: a 101 upgrade entry carrying `_webSocketMessages`.
const wsStart = base / 1000;
const webSocketHar = {
  log: {
    entries: [
      sampleHar.log.entries[0],
      {
        startedDateTime: new Date(base + 500).toISOString(),
        time: 4200,
        request: {
          method: "GET",
          url: "wss://realtime.example.com/v1/socket",
          headers: [
            { name: "upgrade", value: "websocket" },
            { name: "connection", value: "Upgrade" },
          ],
        },
        response: {
          status: 101,
          statusText: "Switching Protocols",
          headers: [{ name: "upgrade", value: "websocket" }],
          content: { size: 0, mimeType: "" },
        },
        _webSocketMessages: [
          { type: "send", time: wsStart + 0.5, opcode: 1, data: JSON.stringify({ op: "subscribe", channel: "runs" }) },
          { type: "receive", time: wsStart + 0.62, opcode: 1, data: JSON.stringify({ op: "ack", channel: "runs" }) },
          { type: "receive", time: wsStart + 1.9, opcode: 1, data: JSON.stringify({ op: "event", data: { runId: "r-1", status: "running" } }) },
          { type: "send", time: wsStart + 3.1, opcode: 1, data: "ping" },
          { type: "receive", time: wsStart + 3.12, opcode: 1, data: "pong" },
          // Binary frame that is valid UTF-8, and one that is not.
          { type: "receive", time: wsStart + 4.0, opcode: 2, data: btoa(JSON.stringify({ op: "binary-json" })) },
          { type: "receive", time: wsStart + 4.2, opcode: 2, data: btoa(String.fromCharCode(0xff, 0xfe, 0x00, 0x81)) },
        ],
      },
      sampleHar.log.entries[1],
    ],
  },
};

const meta = {
  component: HarNetworkViewer,
  tags: ["ai-generated", "needs-work"],
  parameters: {
    layout: "fullscreen",
    msw: { handlers: [harHandler] },
  },
  // Stand-in for the portal's sticky 3rem app header (see Layout.tsx), so the
  // detail panel's sticky offset renders the way it does in the portal.
  decorators: [
    (Story) => (
      <>
        <div className="sticky top-0 z-50 flex h-12 items-center border-b border-border/60 bg-background px-3 text-sm text-muted-foreground">
          App header
        </div>
        <div className="w-full px-6 py-6 lg:px-8">
          <Story />
        </div>
      </>
    ),
  ],
} satisfies Meta<typeof HarNetworkViewer>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Scroll down and select a lower row: the detail panel should stay in view. */
export const LongList: Story = {
  args: { runId: "demo-run" },
};

/**
 * A WebSocket connection shows as type "ws". Selecting it opens the Messages
 * tab with every frame, its direction, timing and decoded payload.
 */
export const WithWebSocket: Story = {
  args: { runId: "demo-run" },
  parameters: {
    msw: { handlers: [http.get("*/api/v1/requests/:id/har", () => HttpResponse.json(webSocketHar))] },
  },
};
