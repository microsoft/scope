// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import { setupServer } from "msw/node";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { AuthContext } from "@/contexts/AuthContext";
import { signedInAuth } from "@/contexts/authFixtures";
import { ProjectProvider } from "@/contexts/ProjectContext";
import * as downloads from "./ArtifactDownloadButton.stories";
import * as network from "./HarNetworkViewer.stories";
import * as conversation from "./ConversationView.stories";

const server = setupServer();
const documentUrl = window.location.href;
let downloadClick: MockInstance<typeof HTMLAnchorElement.prototype.click>;
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  window.location.href = documentUrl;
  downloadClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});
afterAll(() => server.close());
afterEach(() => {
  cleanup();
  window.dispatchEvent(new Event("pagehide"));
  toast.dismiss();
  server.resetHandlers();
  server.events.removeAllListeners();
  vi.restoreAllMocks();
  window.location.href = documentUrl;
});

describe("artifact interaction stories", () => {
  const downloadStories = composeStories(downloads);
  it("shows pending state and permits cancellation", async () => {
    let requestSignal: AbortSignal | undefined;
    server.events.on("request:start", ({ request }) => {
      if (new URL(request.url).pathname.endsWith("/archive")) requestSignal = request.signal;
    });
    server.use(...downloads.PendingAndCancel.parameters.msw.handlers);
    const client = new QueryClient();
    const { container } = render(<QueryClientProvider client={client}>
      <AuthContext.Provider value={signedInAuth}><ProjectProvider>
        <downloadStories.PendingAndCancel />
      </ProjectProvider></AuthContext.Provider>
    </QueryClientProvider>);
    await downloads.PendingAndCancel.play({ canvas: within(container) });
    await waitFor(() => expect(requestSignal?.aborted).toBe(true));
    expect(downloadClick).not.toHaveBeenCalled();
    expect(window.location.href).toBe(documentUrl);
    client.clear();
  });

  it("dispatches a ready download without navigating the test document", async () => {
    server.use(...downloads.Ready.parameters.msw.handlers);
    const { container } = render(<AuthContext.Provider value={signedInAuth}><ProjectProvider>
      <downloadStories.Ready />
    </ProjectProvider></AuthContext.Provider>);
    const action = await within(container).findByRole("button", { name: "Download archive" });
    await waitFor(() => expect(action.hasAttribute("disabled")).toBe(false));
    fireEvent.click(action);
    await waitFor(() => expect(downloadClick).toHaveBeenCalledTimes(1));
    expect(downloadClick.mock.contexts[0]).toMatchObject({
      download: "demo.tar.gz", href: expect.stringMatching(/^blob:/),
    });
    expect(window.location.href).toBe(documentUrl);
  });

  it("shows a download authorization failure", async () => {
    server.use(...downloads.AccessDenied.parameters.msw.handlers);
    const { container } = render(<AuthContext.Provider value={signedInAuth}><ProjectProvider>
      <downloadStories.AccessDenied />
    </ProjectProvider></AuthContext.Provider>);
    await downloads.AccessDenied.play({ canvas: within(container) });
  });

  it("shows a HAR authorization failure", async () => {
    server.use(...network.AccessDenied.parameters.msw.handlers);
    const stories = composeStories(network);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(<QueryClientProvider client={client}>
      <AuthContext.Provider value={signedInAuth}><ProjectProvider>
        <stories.AccessDenied />
      </ProjectProvider></AuthContext.Provider>
    </QueryClientProvider>);
    await network.AccessDenied.play({ canvas: within(container) });
    client.clear();
  });

  it("shows a conversation HAR failure without hiding the stored response", async () => {
    server.use(...conversation.HarAccessDenied.parameters.msw.handlers);
    const stories = composeStories(conversation);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(<QueryClientProvider client={client}>
      <AuthContext.Provider value={signedInAuth}><ProjectProvider>
        <stories.HarAccessDenied />
      </ProjectProvider></AuthContext.Provider>
    </QueryClientProvider>);
    await conversation.HarAccessDenied.play({ canvas: within(container) });
    client.clear();
  });
});
