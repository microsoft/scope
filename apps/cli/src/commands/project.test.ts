// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Command } from "commander";
import { projectPermissions } from "shared/rbac";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerProjectCommands } from "./project.js";
import { resetApiClient } from "../utils/api-client.js";

const config = vi.hoisted(() => ({
  getSelectedProjectId: vi.fn(), resolveProjectId: vi.fn(), setSelectedProjectId: vi.fn(),
}));
vi.mock("../utils/config.js", () => config);

describe("project CLI explicit membership selection", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const project = { _id: "fixture-project", id: "fixture-project", name: "Fixture", createdAt: "2026-01-01T00:00:00Z" };

  beforeEach(() => {
    vi.clearAllMocks();
    resetApiClient();
    vi.stubEnv("SCOPE_TOKEN", "fixture-raw-idp-bearer");
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(code => { throw new Error(`exit:${code}`); });
  });
  afterEach(() => {
    resetApiClient();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  async function run(...args: string[]) {
    const program = new Command().exitOverride();
    registerProjectCommands(program);
    await program.parseAsync(["project", ...args, "--url", "http://localhost:3101"], { from: "user" });
  }

  it("selects a newly created project only after confirming its creator membership", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(project, { status: 201 })).mockResolvedValueOnce(Response.json({ authEnabled: true })).mockResolvedValueOnce(Response.json({
      capabilities: {
        platformAdmin: true, reportsEnabled: false,
        memberships: [{ projectId: project.id, role: "admin", revision: 1, permissions: projectPermissions("admin") }],
      },
    }));
    await run("create", "--name", "Fixture", "--use");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(config.setSelectedProjectId).toHaveBeenCalledWith(project.id);
  });

  it("does not select an idempotently replayed creation after membership was revoked", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(project, { status: 201 })).mockResolvedValueOnce(Response.json({ authEnabled: true })).mockResolvedValueOnce(Response.json({
      capabilities: { platformAdmin: true, reportsEnabled: false, memberships: [] },
    }));
    await expect(run("create", "--name", "Fixture", "--use")).rejects.toThrow("exit:1");
    expect(config.setSelectedProjectId).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("explicit active membership"));
  });

  it("does not select content for a no-membership platform administrator", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(project)).mockResolvedValueOnce(Response.json({ authEnabled: true })).mockResolvedValueOnce(Response.json({
      capabilities: { platformAdmin: true, reportsEnabled: false, memberships: [] },
    }));
    await expect(run("use", project.id)).rejects.toThrow("exit:1");
    expect(config.setSelectedProjectId).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("explicit active membership"));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each(["reader", "contributor", "admin"] as const)("selects a project with an explicit %s membership using GET only", async role => {
    fetchMock.mockResolvedValueOnce(Response.json(project)).mockResolvedValueOnce(Response.json({ authEnabled: true })).mockResolvedValueOnce(Response.json({
      capabilities: {
        platformAdmin: false, reportsEnabled: false,
        memberships: [{ projectId: project.id, role, revision: 1, permissions: projectPermissions(role) }],
      },
    }));
    await run("use", project.id);
    expect(config.setSelectedProjectId).toHaveBeenCalledWith(project.id);
    for (const [input] of fetchMock.mock.calls) {
      if (!(input instanceof Request)) throw new Error("Expected the centralized raw-bearer transport");
      expect(input.method).toBe("GET");
      expect(input.headers.get("Authorization")).toBe("Bearer fixture-raw-idp-bearer");
    }
  });

  it("creates a project without changing saved selection unless requested", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(project, { status: 201 }));
    await run("create", "--name", "Fixture", "--output", "json");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(config.setSelectedProjectId).not.toHaveBeenCalled();
  });

  it.each([["use", "fixture-project"], ["create", "--name", "Fixture", "--use"]])(
    "selects without an identity only when the API explicitly reports auth off: %j", async (...args) => {
      vi.stubEnv("SCOPE_TOKEN", "");
      fetchMock.mockResolvedValueOnce(Response.json(project)).mockResolvedValueOnce(Response.json({ authEnabled: false }));
      await run(...args);
      expect(config.setSelectedProjectId).toHaveBeenCalledWith(project.id);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      for (const [input] of fetchMock.mock.calls) {
        if (!(input instanceof Request)) throw new Error("Expected centralized transport");
        expect(input.headers.has("Authorization")).toBe(false);
        expect(input.url).not.toContain("/users/me");
      }
    },
  );

  it("does not infer anonymous mode from a missing or malformed API mode", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(project)).mockResolvedValueOnce(Response.json({}));
    await expect(run("use", project.id)).rejects.toThrow("exit:1");
    expect(config.setSelectedProjectId).not.toHaveBeenCalled();
  });

  it("does not claim success for a pending project creation", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ operationId: "uncertain-create", state: "pending" }, { status: 202 }));
    await expect(run("create", "--name", "Fixture")).rejects.toThrow("exit:1");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("Completion is not confirmed"));
    expect(config.setSelectedProjectId).not.toHaveBeenCalled();
  });
});
