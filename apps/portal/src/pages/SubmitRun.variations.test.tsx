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

function profile(id: string, name: string, repo: string): ProfileWithVersion {
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
      resources: [{ ref: resourceRef, params: { REPO: repo } }],
      createdAt,
    },
  };
}

const profiles = [
  profile("baseline", "Baseline profile", "baseline/repository"),
  profile("comparison", "Comparison profile", "comparison/repository"),
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
  parameters: [{ name: "REPO", required: true }],
  contentSha256: "sha",
  createdAt,
};

let queryClient: QueryClient;

beforeEach(() => {
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
  it("does not copy baseline profile-managed configuration into the shared request", async () => {
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
    await user.click(screen.getByRole("button", { name: "Add" }));

    fireEvent.change(screen.getByLabelText("Task *"), { target: { value: "Build a demo" } });
    fireEvent.change(screen.getByLabelText("Max iterations"), { target: { value: "1" } });
    await user.click(screen.getByRole("button", { name: /Submit 10 Runs/ }));

    await waitFor(() => expect(api.submitRun).toHaveBeenCalledOnce());
    const payload = vi.mocked(api.submitRun).mock.calls[0][0];

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
