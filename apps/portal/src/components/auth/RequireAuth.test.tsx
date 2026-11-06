// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthContext } from "@/contexts/AuthContext";
import { signedInAuth, signedOutAuth } from "@/contexts/authFixtures";
import { RequireAuth } from "./RequireAuth";
import * as stories from "./RequireAuth.stories";

const config = vi.hoisted(() => ({ enabled: true, configured: true }));
vi.mock("@/lib/auth/msalInstance", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/auth/msalInstance")>(),
  get isAuthEnabled() { return config.enabled; },
  get isAuthConfigured() { return config.configured; },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  config.enabled = true;
  config.configured = true;
});

describe("Scope welcome and account access", () => {
  for (const [name, Story] of Object.entries(composeStories(stories))) {
    it(`${name} renders and its interaction passes`, async () => {
      const { container } = render(<Story />);
      if (!Story.play) throw new Error("Each auth story must exercise its state");
      await Story.play({ canvas: within(container), canvasElement: container });
    });
  }

  it("renders the application only after Scope has accepted the account", () => {
    render(
      <AuthContext.Provider value={signedInAuth}>
        <RequireAuth>Private application</RequireAuth>
      </AuthContext.Provider>,
    );
    expect(screen.getByText("Private application")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Log in" })).toBeNull();
  });

  it("keeps the explicit authentication-disabled mode unchanged", () => {
    config.enabled = false;
    render(
      <AuthContext.Provider value={signedOutAuth}>
        <RequireAuth>Anonymous application</RequireAuth>
      </AuthContext.Provider>,
    );
    expect(screen.getByText("Anonymous application")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Log in" })).toBeNull();
  });

  it("explains missing configuration without offering a broken sign-in", () => {
    config.configured = false;
    render(
      <AuthContext.Provider value={signedOutAuth}>
        <RequireAuth>Private application</RequireAuth>
      </AuthContext.Provider>,
    );
    expect(screen.getByRole("alert").textContent).toContain("Authentication not configured");
    expect(screen.queryByRole("button", { name: "Log in" })).toBeNull();
    expect(screen.queryByText("Private application")).toBeNull();
  });
});
