// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import express from "express";
import request from "supertest";
import { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerServerRoutes } from "./server.js";

const status = {
  agents: [{
    workerType: "coder-acp-copilot-host",
    label: "Copilot host",
    runtime: "host",
    enabled: true,
    available: true,
  }],
};

function app(controlUrl = "") {
  const app = express();
  app.use(express.json());
  registerServerRoutes({ app, registry: new OpenAPIRegistry() }, controlUrl);
  return app;
}

describe("local server agent setup", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("leaves deployed servers without a local control endpoint unchanged", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await request(app()).get("/api/v1/server").expect(200, { enabled: false, agents: [] });
    await request(app()).put("/api/v1/server/agents/coder-acp-copilot-host")
      .send({ enabled: true, consent: true }).expect(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports real launcher status", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(status));
    vi.stubGlobal("fetch", fetch);
    await request(app("http://launcher:4100")).get("/api/v1/server")
      .expect(200, { enabled: true, ...status });
    expect(String(fetch.mock.calls[0][0])).toBe("http://launcher:4100/status");
  });

  it("forwards a finite setup operation and explicit host consent", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(status));
    vi.stubGlobal("fetch", fetch);
    await request(app("http://launcher:4100")).put("/api/v1/server/agents/coder-acp-copilot-host")
      .send({ enabled: true, executable: "/usr/local/bin/copilot", consent: true }).expect(200);
    expect(String(fetch.mock.calls[0][0])).toBe("http://launcher:4100/agents/coder-acp-copilot-host");
    expect(fetch).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ enabled: true, executable: "/usr/local/bin/copilot", consent: true }),
    }));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown workers and arbitrary setup fields before calling the launcher", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await request(app("http://launcher:4100")).put("/api/v1/server/agents/arbitrary")
      .send({ enabled: true }).expect(400);
    await request(app("http://launcher:4100")).put("/api/v1/server/agents/coder-acp-copilot")
      .send({ enabled: true, command: "not-a-supported-setting" }).expect(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves setup conflicts without replaying a mutation", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ error: "Agent has active work" }, { status: 409 }));
    vi.stubGlobal("fetch", fetch);
    await request(app("http://launcher:4100")).put("/api/v1/server/agents/coder-acp-copilot-host")
      .send({ enabled: false }).expect(409, { error: "Agent has active work" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    new TypeError("fetch failed"),
    new DOMException("Request timed out", "TimeoutError"),
  ])("reports unavailable launcher connections without replaying setup: %s", async (error) => {
    const fetch = vi.fn().mockRejectedValue(error);
    vi.stubGlobal("fetch", fetch);
    await request(app("http://launcher:4100")).put("/api/v1/server/agents/coder-acp-copilot-host")
      .send({ enabled: false }).expect(503, {
        error: "Cannot reach the local Scope launcher. Check that scope-server is running.",
      });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries a transient status connection failure", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValue(Response.json(status));
    vi.stubGlobal("fetch", fetch);
    await request(app("http://launcher:4100")).get("/api/v1/server")
      .expect(200, { enabled: true, ...status });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
