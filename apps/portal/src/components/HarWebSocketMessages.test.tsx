// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { HarWebSocketMessages } from "./HarWebSocketMessages";
import { HarNetworkViewer } from "./HarNetworkViewer";
import type { HarWebSocketMessage } from "@/lib/har-websocket";

vi.mock("@/hooks/useHarExtraction", () => ({
  useHarData: () => ({ data: mockHar, isLoading: false, error: null }),
}));

afterEach(cleanup);

const MESSAGES: HarWebSocketMessage[] = [
  { type: "send", time: 100, opcode: 1, data: '{"op":"subscribe"}' },
  { type: "receive", time: 100.5, opcode: 1, data: '{"op":"ack"}' },
  { type: "receive", time: 101, opcode: 1, data: "pong" },
];

/** HAR served to HarNetworkViewer through the mocked `useHarData` hook. */
const mockHar = {
  log: {
    entries: [
      {
        startedDateTime: "2026-06-21T12:00:00.000Z",
        time: 12,
        request: { method: "GET", url: "https://api.example.com/v1/items", headers: [] },
        response: { status: 200, statusText: "OK", headers: [], content: { size: 10, mimeType: "application/json", text: "{}" } },
      },
      {
        startedDateTime: "2026-06-21T12:00:01.000Z",
        time: 3000,
        request: { method: "GET", url: "wss://realtime.example.com/socket", headers: [] },
        response: { status: 101, statusText: "Switching Protocols", headers: [], content: { size: 0, mimeType: "" } },
        _webSocketMessages: MESSAGES,
      },
    ],
  },
};

/** The rendered message list items. */
function messageItems() {
  return within(screen.getByRole("list", { name: /websocket messages/i })).getAllByRole("listitem");
}

describe("HarWebSocketMessages", () => {
  it("lists every frame with direction, offset and pretty-printed JSON", () => {
    render(<HarWebSocketMessages messages={MESSAGES} />);

    expect(screen.getByText(/1 sent · 2 received/)).toBeTruthy();
    const items = messageItems();
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain("Sent");
    expect(items[0].textContent).toContain("+0.000 s");
    expect(items[0].querySelector("pre")?.textContent).toBe('{\n  "op": "subscribe"\n}');
    expect(items[1].textContent).toContain("+0.500 s");
    expect(items[2].querySelector("pre")?.textContent).toBe("pong");
  });

  it("filters by direction", () => {
    render(<HarWebSocketMessages messages={MESSAGES} />);

    fireEvent.click(screen.getByRole("button", { name: "Received" }));
    expect(messageItems()).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Received" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Sent" }));
    expect(messageItems()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(messageItems()).toHaveLength(3);
  });

  it("says so when the connection recorded no frames", () => {
    render(<HarWebSocketMessages messages={[]} />);
    expect(screen.getByText(/no messages recorded/i)).toBeTruthy();
  });
});

describe("HarNetworkViewer WebSocket support", () => {
  it("marks WebSocket connections and counts their messages", () => {
    render(<HarNetworkViewer runId="run-1" />);

    expect(screen.getByText("3 WebSocket messages")).toBeTruthy();
    const wsRow = screen.getByText("/socket").closest("tr")!;
    expect(within(wsRow).getByText("ws")).toBeTruthy();
  });

  it("opens a WebSocket entry on its Messages tab", () => {
    render(<HarNetworkViewer runId="run-1" />);

    fireEvent.click(screen.getByText("/socket"));
    expect(screen.getByRole("button", { name: "Messages" })).toBeTruthy();
    expect(messageItems()).toHaveLength(3);
  });

  it("shows no Messages tab for plain HTTP entries", () => {
    render(<HarNetworkViewer runId="run-1" />);

    fireEvent.click(screen.getByText("/v1/items"));
    expect(screen.queryByRole("button", { name: "Messages" })).toBeNull();
    expect(screen.getByRole("button", { name: "Headers" })).toBeTruthy();
  });
});
