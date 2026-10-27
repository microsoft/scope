// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { composeStories } from "@storybook/react-vite";
import { setupServer } from "msw/node";
import { http, HttpResponse, type RequestHandler } from "msw";
import { ProjectProvider } from "@/contexts/ProjectContext";
import { ProjectCreateForm } from "@/components/ProjectCreateForm";
import type { Project } from "@/types";
import * as projects from "./Projects.stories";

const server = setupServer();
const clients: QueryClient[] = [];
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
  localStorage.clear();
  server.resetHandlers();
});

describe("Project management RBAC", () => {
  for (const [name, Story] of Object.entries(composeStories(projects))) {
    it(`${name} renders and play passes`, async () => {
      const parameters: { msw?: { handlers?: RequestHandler[] } } = Story.parameters;
      server.use(...(parameters.msw?.handlers ?? []));
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      clients.push(client);
      const { container } = render(
        <QueryClientProvider client={client}><ProjectProvider><MemoryRouter>
          <Story />
        </MemoryRouter></ProjectProvider></QueryClientProvider>,
      );
      if (!Story.play) throw new Error(`${name} is missing its required interaction test`);
      await Story.play({ canvas: within(container), canvasElement: container });
    });
  }

  it("creation refreshes canonical inventories without synthesizing a client membership", async () => {
    const created: Project = {
      _id: "new-project", id: "new-project", name: "Created project",
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    };
    server.use(http.post("/api/v1/projects", () => HttpResponse.json(created, { status: 201 })));
    const client = new QueryClient();
    clients.push(client);
    client.setQueryData<Project[]>(["projects"], []);
    client.setQueryData(["access-projects"], []);
    let result: Project | undefined;
    render(<QueryClientProvider client={client}>
      <ProjectCreateForm onCreated={project => { result = project; }} />
    </QueryClientProvider>);
    fireEvent.change(screen.getByLabelText("Name *"), { target: { value: created.name } });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(result?._id).toBe(created._id));
    expect(client.getQueryData(["projects"])).toEqual([]);
    expect(client.getQueryState(["projects"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["access-projects"])?.isInvalidated).toBe(true);
  });

  it("keeps the creation idempotency key after an uncertain creator-membership outcome", async () => {
    const keys: Array<string | null> = [];
    server.use(http.post("/api/v1/projects", ({ request }) => {
      keys.push(request.headers.get("Idempotency-Key"));
      return keys.length === 1
        ? HttpResponse.json({ operationId: keys[0], state: "pending" }, { status: 202 })
        : HttpResponse.json({ _id: "same-project", name: "Retry fixture" }, { status: 201 });
    }));
    const client = new QueryClient();
    clients.push(client);
    let completed = false;
    render(<QueryClientProvider client={client}>
      <ProjectCreateForm onCreated={() => { completed = true; }} />
    </QueryClientProvider>);
    fireEvent.change(screen.getByLabelText("Name *"), { target: { value: "Retry fixture" } });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(keys).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Create project" })).toHaveProperty("disabled", false));
    expect(completed).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(completed).toBe(true));
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });
});
