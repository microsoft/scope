// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type {
  CodingAgent,
  ProfileWithVersion,
  ResourceDocument,
  ResourceRevisionDocument,
} from "@/types";

vi.mock("@/hooks/useVisibleGates", () => ({
  useVisibleGates: () => ["select"],
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@/lib/api", () => ({
  api: {
    getVersion: vi.fn(async () => ({ strictAgentCapabilities: true })),
    listAgents: vi.fn(),
    listProfiles: vi.fn(),
    listProfileVersions: vi.fn(),
    listMcpServers: vi.fn(async () => []),
    listRuns: vi.fn(async () => ({ data: [] })),
    listModels: vi.fn(async () => []),
    listCriteria: vi.fn(async () => []),
    listTaskPrompts: vi.fn(async () => ({ data: [] })),
    listResources: vi.fn(),
    listResourceRevisions: vi.fn(),
    submitRun: vi.fn(async () => ({ ids: ["run-base", "run-variation"] })),
  },
}));

import { api } from "@/lib/api";
import { toast } from "sonner";
import { SubmitRun } from "./SubmitRun";

const createdAt = "2026-01-01T00:00:00.000Z";
const resourceRef = "github-simulator@r1";

const agent: CodingAgent = {
  _id: "coder-acp-copilot",
  name: "GitHub Copilot CLI",
  supportedModels: ["gpt-5.6-sol"],
  defaultModel: "gpt-5.6-sol",
  available: true,
  capabilities: {
    supportsReasoningEffort: true,
    supportsMcpServers: false,
    supportsSkills: false,
    supportsExtensions: false,
  },
  versions: [{
    agentVersion: "1.0",
    workerVersion: "1.0",
    components: {},
    gitCommit: "abc",
    buildTime: createdAt,
    imageTag: "test",
    queueName: "test-queue",
    status: "active",
    createdAt,
  }],
  createdAt,
};

/**
 * Builds a profile fixture with an optional profile-managed repository binding.
 *
 * @param id Stable profile identifier used in submitted references.
 * @param name Display name selected through the profile picker.
 * @param repo Optional repository parameter value owned by this profile.
 */
function profile(id: string, name: string, repo?: string): ProfileWithVersion {
  return {
    _id: id,
    name,
    latestVersion: 1,
    createdAt,
    version: {
      _id: `${id}-v1`,
      profileId: id,
      version: 1,
      workerType: agent._id,
      model: "gpt-5.6-sol",
      agentVersion: "1.0",
      ...(repo ? { resources: [{ ref: resourceRef, params: { REPO: repo } }] } : {}),
      createdAt,
    },
  };
}

const profiles = [
  profile("baseline", "Baseline profile", "baseline/repository"),
  profile("comparison", "Comparison profile", "comparison/repository"),
  profile("run-owned-resources", "Run-owned resources profile"),
];

const resource: ResourceDocument = {
  _id: "resource-1",
  projectId: "project-1",
  slug: "github-simulator",
  name: "GitHub simulator",
  revisionCounter: 1,
  latestRevisionId: "resource-revision-1",
  latestRevisionNumber: 1,
  createdAt,
};

const resourceRevision: ResourceRevisionDocument = {
  _id: "resource-revision-1",
  resourceId: resource._id,
  projectId: resource.projectId,
  slug: resource.slug,
  revisionNumber: 1,
  ref: resourceRef,
  setup: { sh: "echo ready" },
  exports: [],
  parameters: [
    { name: "REPO", required: true },
    { name: "SCENARIO", required: false, default: "default-scenario" },
  ],
  contentSha256: "sha",
  createdAt,
};

let queryClient: QueryClient;

beforeEach(() => {
  // Recreate the API fixtures and query cache for each rendered wizard so
  // profile selection state cannot leak between tests.
  vi.mocked(api.listAgents).mockResolvedValue([agent]);
  vi.mocked(api.listProfiles).mockResolvedValue(profiles);
  vi.mocked(api.listProfileVersions).mockImplementation(async (profileId) => [
    profiles.find((candidate) => candidate._id === profileId)!.version,
  ]);
  vi.mocked(api.listResources).mockResolvedValue([resource]);
  vi.mocked(api.listResourceRevisions).mockResolvedValue([resourceRevision]);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.clearAllMocks();
});

describe("SubmitRun profile variation payload", () => {
  it("keeps resources editable when the selected profile does not manage them", async () => {
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SubmitRun />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const baseProfileInput = await screen.findByPlaceholderText("Search existing profiles…");
    fireEvent.change(baseProfileInput, { target: { value: "Run-owned resources profile" } });
    await user.click(screen.getByRole("listitem"));
    await user.click(screen.getByRole("button", { name: /Resources/ }));

    expect(await screen.findByPlaceholderText("Search resources…")).toBeTruthy();
    expect(screen.getByText("Create a resource")).toBeTruthy();
  });

  it("locks profile-managed resource bindings while keeping unset parameters editable", async () => {
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SubmitRun />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const baseProfileInput = await screen.findByPlaceholderText("Search existing profiles…");
    fireEvent.change(baseProfileInput, { target: { value: "Baseline profile" } });
    await user.click(screen.getByRole("listitem"));

    const profileParameter = await screen.findByLabelText("REPO") as HTMLInputElement;
    expect(profileParameter.disabled).toBe(true);
    expect(profileParameter.value).toBe("baseline/repository");

    const runParameter = screen.getByLabelText("SCENARIO") as HTMLInputElement;
    expect(runParameter.disabled).toBe(false);
    const agentSectionTitle = screen.getByText("Agent");
    const resourcesSectionTitle = screen.getByText("Resources");
    const resourcesFollowAgent = agentSectionTitle.compareDocumentPosition(resourcesSectionTitle)
      & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(resourcesFollowAgent).not.toBe(0);
    expect(screen.queryByPlaceholderText("Search resources…")).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();

    fireEvent.change(runParameter, { target: { value: "custom-scenario" } });
    fireEvent.change(screen.getByLabelText("Task *"), { target: { value: "Build a demo" } });
    fireEvent.change(screen.getByLabelText("Max iterations"), { target: { value: "1" } });
    await user.click(screen.getByRole("button", { name: /Submit 5 Runs/ }));

    await waitFor(() => expect(api.submitRun).toHaveBeenCalledOnce());
    expect(vi.mocked(api.submitRun).mock.calls[0][0]).toEqual(expect.objectContaining({
      resources: [{
        ref: resourceRef,
        params: {
          REPO: "baseline/repository",
          SCENARIO: "custom-scenario",
        },
      }],
    }));
  });

  it("discards and disables run-owned resource edits when a variation is added", async () => {
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SubmitRun />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Fill a parameter gap that is valid for a single-profile run, then switch
    // into comparison mode where request-level resources are not submitted.
    const baseProfileInput = await screen.findByPlaceholderText("Search existing profiles…");
    fireEvent.change(baseProfileInput, { target: { value: "Baseline profile" } });
    await user.click(screen.getByRole("listitem"));
    const scenarioParameter = await screen.findByLabelText("SCENARIO") as HTMLInputElement;
    fireEvent.change(scenarioParameter, { target: { value: "custom-scenario" } });
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(
      "Run-owned resource edits were removed. Profile variations resolve resources independently, so every selected profile must provide complete resource bindings and required parameters.",
    ));
    expect(scenarioParameter.disabled).toBe(true);
    expect(scenarioParameter.value).toBe("default-scenario");
    expect(screen.getByText(
      "Profile variations resolve resources independently. Every selected profile must provide complete resource bindings and required parameters; run-owned resource edits are unavailable in variation mode.",
    )).toBeTruthy();
  });

  it("does not copy baseline profile-managed configuration into the shared request", async () => {
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SubmitRun />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Select the baseline and comparison profiles through the same controls a
    // user exercises in the submission wizard.
    const baseProfileInput = await screen.findByPlaceholderText("Search existing profiles…");
    fireEvent.change(baseProfileInput, { target: { value: "Baseline profile" } });
    await user.click(screen.getByRole("listitem"));
    await user.click(screen.getByRole("button", { name: "Add" }));

    // Supply only run-wide inputs, then submit the comparative request.
    fireEvent.change(screen.getByLabelText("Task *"), { target: { value: "Build a demo" } });
    fireEvent.change(screen.getByLabelText("Max iterations"), { target: { value: "1" } });
    await user.click(screen.getByRole("button", { name: /Submit 10 Runs/ }));

    await waitFor(() => expect(api.submitRun).toHaveBeenCalledOnce());
    const payload = vi.mocked(api.submitRun).mock.calls[0][0];

    // The Portal sends profile references but leaves every profile-managed
    // field for independent API resolution.
    expect(payload).toEqual(expect.objectContaining({
      profileId: "baseline@1",
      profileVariations: ["comparison@1"],
    }));
    expect(payload).not.toHaveProperty("worker");
    expect(payload).not.toHaveProperty("model");
    expect(payload).not.toHaveProperty("reasoningEffort");
    expect(payload).not.toHaveProperty("agentVersion");
    expect(payload).not.toHaveProperty("mcpServers");
    expect(payload).not.toHaveProperty("skills");
    expect(payload).not.toHaveProperty("extensions");
    expect(payload).not.toHaveProperty("resources");
  });
});
