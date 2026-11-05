// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import { setupServer } from "msw/node";
import { http, HttpResponse, type RequestHandler } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setApiSessionSignal, setApiTokenProvider, resetApiClient } from "@/lib/api-client";
import { AuthModeGate } from "./AuthModeGate";
import * as stories from "./AuthModeGate.stories";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => { cleanup(); resetApiClient(); server.resetHandlers(); });
afterAll(() => server.close());

describe("Deployment mode bootstrap", () => {
  for (const [name, Story] of Object.entries(composeStories(stories))) {
    it(`${name} renders and play passes`, async () => {
      const parameters: { msw?: { handlers?: RequestHandler[] } } = Story.parameters;
      server.use(...(parameters.msw?.handlers ?? []));
      const { container } = render(<Story />);
      if (!Story.play) throw new Error("Story must cover its state");
      await Story.play({ canvas: within(container), canvasElement: container });
    });
  }

  it("checks the public API mode without bearer acquisition or stale account cancellation", async () => {
    const token = vi.fn(() => "must-not-be-sent");
    setApiTokenProvider(token);
    setApiSessionSignal(AbortSignal.abort());
    server.use(http.get("/api/v1/version", ({ request }) => {
      expect(request.headers.has("Authorization")).toBe(false);
      return HttpResponse.json({ authEnabled: false });
    }));
    render(<AuthModeGate expectedEnabled={false}>Anonymous application</AuthModeGate>);
    await screen.findByText("Anonymous application");
    expect(token).not.toHaveBeenCalled();
  });

  it("does not turn a failed API mode check into anonymous access", async () => {
    server.use(http.get("/api/v1/version", () => HttpResponse.json({ error: "Not available" }, { status: 404 })));
    render(<AuthModeGate expectedEnabled={false}>Anonymous application</AuthModeGate>);
    await screen.findByRole("alert");
    expect(screen.queryByText("Anonymous application")).toBeNull();
  });
});
