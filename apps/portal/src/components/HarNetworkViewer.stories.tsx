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
