// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";
import { http, HttpResponse } from "msw";
import type { ConversationTurn } from "@/types";
import type { HarFile } from "@/lib/har-extraction";
import { ConversationView } from "./ConversationView";

export const conversationTurn: ConversationTurn = {
  iteration: 1,
  codingAgentResponse: "I checked the documentation and opened the example.",
  judgeFeedback: "The example is ready.",
  snapshotUrl: "",
  passed: true,
  timestamp: "2026-01-01T12:00:00Z",
  harUrl: "https://example.com/synthetic.har",
};

export const conversationHar: HarFile = {
  log: {
    entries: [{
      startedDateTime: conversationTurn.timestamp,
      request: {
        method: "POST",
        url: "https://example.com/chat/completions",
        postData: {
          text: JSON.stringify({
            messages: [
              { role: "tool", tool_call_id: "docs", content: "Documentation found." },
              { role: "tool", tool_call_id: "browser", content: "Example opened." },
            ],
          }),
        },
      },
      response: {
        content: {
          text: JSON.stringify({
            choices: [{
              message: {
                tool_calls: [
                  { id: "docs", function: { name: "docs-server-search_docs", arguments: '{"query":"example"}' } },
                  { id: "browser", function: { name: "mcp__browser-tools__navigate", arguments: '{"url":"https://example.com"}' } },
                  { id: "file", function: { name: "read_file", arguments: '{"path":"README.md"}' } },
                  { id: "legacy", function: { name: "unknown-server-search", arguments: "{}" } },
                ],
              },
            }],
          }),
        },
      },
    }],
  },
};

const meta = {
  component: ConversationView,
  includeStories: ["McpAndBuiltInTools", "HistoricalNamesWithoutServerMetadata"],
  tags: ["ai-generated", "needs-work"],
  args: {
    runId: "demo-run",
    turns: [conversationTurn],
    task: "Open the documentation example.",
    mcpServers: ["docs-server"],
  },
  parameters: {
    msw: {
      handlers: [
        http.get("*/api/v1/requests/:id/har", () => HttpResponse.json(conversationHar)),
      ],
    },
  },
} satisfies Meta<typeof ConversationView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const McpAndBuiltInTools: Story = {
  play: async ({ canvas }) => {
    const docs = await canvas.findByRole("button", { name: /MCP: docs-server.*search_docs/ });
    await expect(canvas.getByText("MCP: browser-tools")).toBeVisible();
    await expect(canvas.getByText("read_file")).toBeVisible();
    await expect(canvas.getByText("unknown-server-search")).toBeVisible();
    await userEvent.click(docs);
    await expect(canvas.getByText("docs-server-search_docs")).toBeVisible();
    await expect(canvas.getByText("Documentation found.")).toBeVisible();
  },
};

export const HistoricalNamesWithoutServerMetadata: Story = {
  args: { mcpServers: undefined },
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("docs-server-search_docs")).toBeVisible();
    await expect(canvas.queryByText("MCP: docs-server")).toBeNull();
    await expect(canvas.getByText("MCP: browser-tools")).toBeVisible();
  },
};
