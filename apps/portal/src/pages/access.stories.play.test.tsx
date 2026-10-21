// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, describe, it, vi } from "vitest";
import { cleanup, render, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { composeStories } from "@storybook/react-vite";
import { setupServer } from "msw/node";
import { http, HttpResponse, type RequestHandler } from "msw";
import { MemoryRouter } from "react-router-dom";
import { ProjectProvider } from "@/contexts/ProjectContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { mswHandlers } from "../../.storybook/msw-handlers";
import * as administration from "./AccessAdministration.stories";
import * as admin from "./Admin.stories";
import * as projects from "./Projects.stories";
import * as accessShell from "../components/AccessShell.stories";
import * as agentBadge from "../components/AgentBadge.stories";
import * as layout from "../components/Layout.stories";

const server = setupServer(
  ...mswHandlers,
  http.get("/api/v1/version", () => HttpResponse.json({
    commit: "test-commit", buildTime: "1970-01-01T00:00:00Z", authEnabled: true,
  })),
  http.get("/ready", () => HttpResponse.json({
    status: "ready", migrations: { ready: true, applied: [], pending: [], totalApplied: 0 },
  })),
);
const clients: QueryClient[] = [];
beforeAll(() => {
  vi.stubGlobal("__GIT_COMMIT__", "test-commit");
  vi.stubGlobal("__BUILD_TIME__", "1970-01-01T00:00:00Z");
  vi.stubGlobal("__GIT_BRANCH__", "test-branch");
  server.listen({ onUnhandledRequest: "error" });
});
afterAll(() => server.close());
afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
  server.resetHandlers();
  localStorage.clear();
});

const badgeStories = composeStories(agentBadge);
const layoutStories = composeStories(layout);
const stories = {
  ...composeStories(administration), ...composeStories(admin), ...composeStories(accessShell),
  ...Object.fromEntries(Object.entries(composeStories(projects)).map(([name, story]) => [`Projects${name}`, story])),
  AgentBadgeAdmin: badgeStories.Plain, AgentBadgeMember: badgeStories.ProjectMember,
  MemberNavigation: layoutStories.MemberNavigation, AdminNavigation: layoutStories.AdminWithoutMembership,
};
describe("Access story interactions", () => {
  for (const [name, Story] of Object.entries(stories)) {
    it(`${name} renders and play passes`, async () => {
      const parameters: { msw?: { handlers?: RequestHandler[] } } = Story.parameters;
      server.use(...(parameters.msw?.handlers ?? []));
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      clients.push(client);
      const { container } = render(<QueryClientProvider client={client}><ThemeProvider><ProjectProvider><MemoryRouter><Story /></MemoryRouter></ProjectProvider></ThemeProvider></QueryClientProvider>);
      if (!Story.play) throw new Error(`${name} is missing its required interaction test`);
      await Story.play({ canvas: within(container), canvasElement: container });
    });
  }
});
