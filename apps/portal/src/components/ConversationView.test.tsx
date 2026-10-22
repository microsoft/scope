// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConversationView } from "./ConversationView";
import { conversationHar, conversationTurn } from "./ConversationView.stories";

afterEach(cleanup);

function renderConversation(mcpServers?: string[], attemptRunId?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["har", "demo-run", 1, attemptRunId], conversationHar);
  return render(
    <QueryClientProvider client={client}>
      <ConversationView turns={[conversationTurn]} runId="demo-run" mcpServers={mcpServers} attemptRunId={attemptRunId} />
    </QueryClientProvider>,
  );
}

describe("ConversationView tool labels", () => {
  it("labels namespaced and configured MCP tools while preserving ordinary and unknown names", () => {
    renderConversation(["docs-server"]);
    expect(screen.getByText("MCP: docs-server")).toBeTruthy();
    expect(screen.getByText("search_docs")).toBeTruthy();
    expect(screen.getByText("MCP: browser-tools")).toBeTruthy();
    expect(screen.getByText("navigate")).toBeTruthy();
    expect(screen.getByText("read_file")).toBeTruthy();
    expect(screen.getByText("unknown-server-search")).toBeTruthy();
  });

  it("keeps historical flattened names unchanged without server metadata", () => {
    renderConversation(undefined, "historical-attempt");
    expect(screen.getByText("docs-server-search_docs")).toBeTruthy();
    expect(screen.queryByText("MCP: docs-server")).toBeNull();
    expect(screen.getByText("MCP: browser-tools")).toBeTruthy();
  });

  it("preserves raw names, arguments, responses, timestamps, and expansion behavior", async () => {
    renderConversation(["docs-server"]);
    const button = screen.getByRole("button", { name: /MCP: docs-server.*search_docs/ });
    expect(within(button).queryByText("no response")).toBeNull();
    expect(button.textContent).toContain(new Date(conversationTurn.timestamp).toLocaleTimeString());
    await userEvent.click(button);
    expect(screen.getByText("docs-server-search_docs")).toBeTruthy();
    expect(screen.getByText(/"query": "example"/)).toBeTruthy();
    expect(screen.getByText("Documentation found.")).toBeTruthy();
    await userEvent.click(button);
    expect(screen.queryByText("Recorded tool name:")).toBeNull();
    expect(screen.queryByText("Documentation found.")).toBeNull();

    const ordinary = screen.getByRole("button", { name: /read_file/ });
    expect(within(ordinary).getByText("no response")).toBeTruthy();
    await userEvent.click(ordinary);
    expect(screen.getByText(/"path": "README.md"/)).toBeTruthy();
    expect(within(ordinary).queryByText(/MCP:/)).toBeNull();
  });
});
