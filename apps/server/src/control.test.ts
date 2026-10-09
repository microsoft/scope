// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "./agents.js";
import { startControl } from "./control.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

describe("launcher control interface", () => {
  it("matches the API status/setup contract without exposing arbitrary operations", async () => {
    const path = resolve("apps/server/.test-state", randomUUID());
    await mkdir(path, { recursive: true });
    cleanup.push(() => rm(path, { force: true, recursive: true }));
    const start = vi.fn().mockResolvedValue(undefined);
    const manager = new AgentManager(path, start, vi.fn().mockResolvedValue(undefined));
    await manager.activate();
    const control = await startControl(manager, () => ({ status: "ready", dataDir: path }), vi.fn());
    cleanup.push(control.close);
    const base = `http://127.0.0.1:${control.port}`;
    expect(control.listenHost).toBe("127.0.0.1");
    const response = await fetch(`${base}/status`);
    expect(response.status).toBe(200);
    const status: unknown = await response.json();
    expect(status).toMatchObject({ agents: expect.arrayContaining([
      expect.objectContaining({ workerType: "coder-acp-copilot-host", runtime: "host", available: false }),
    ]) });
    expect(Object.keys(status as object)).toEqual(["agents"]);
    for (const agent of (status as { agents: Record<string, unknown>[] }).agents) {
      expect(Object.keys(agent).sort()).toEqual(["available", "enabled", "label", "runtime", "workerType"]);
    }
    const setup = await fetch(`${base}/agents/coder-acp-copilot-host`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(setup.status).toBe(400);
    const enabled = await fetch(`${base}/agents/coder-acp-copilot-host`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, consent: true }),
    });
    expect(enabled.status).toBe(202);
    const accepted: unknown = await enabled.json();
    expect(Object.keys(accepted as object)).toEqual(["agents"]);
    expect(JSON.stringify(accepted)).not.toContain("consent");
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect((await fetch(`${base}/exec`, { method: "POST" })).status).toBe(404);
  });

  it("returns PUT before a slow setup completes and serves concurrent status polling", async () => {
    const path = resolve("apps/server/.test-state", randomUUID());
    await mkdir(path, { recursive: true });
    cleanup.push(() => rm(path, { force: true, recursive: true }));
    let finish: () => void = () => {};
    const start = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const manager = new AgentManager(path, start, vi.fn().mockResolvedValue(undefined));
    await manager.activate();
    const control = await startControl(manager, () => ({ status: "ready", dataDir: path }), vi.fn());
    cleanup.push(control.close);
    cleanup.push(async () => { finish(); });
    const base = `http://127.0.0.1:${control.port}`;
    const response = await fetch(`${base}/agents/coder-acp-copilot`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
      signal: AbortSignal.timeout(1000),
    });
    expect(response.status).toBe(202);
    expect(start).toHaveBeenCalledOnce();
    const poll = await fetch(`${base}/status`, { signal: AbortSignal.timeout(1000) });
    const pending: unknown = await poll.json();
    expect(pending).toMatchObject({ agents: expect.arrayContaining([
      expect.objectContaining({ workerType: "coder-acp-copilot", enabled: true, available: false }),
    ]) });
    finish();
    await vi.waitFor(() => expect(manager.controlStatus().agents.find(agent => agent.workerType === "coder-acp-copilot")?.available).toBe(true));
  });

  it("rejects wildcard control listeners instead of falling back to one", async () => {
    const manager = new AgentManager("unused", vi.fn(), vi.fn());
    await expect(startControl(manager, () => ({ status: "starting", dataDir: "unused" }), vi.fn(), "0.0.0.0")).rejects.toThrow("explicit local");
    await expect(startControl(manager, () => ({ status: "starting", dataDir: "unused" }), vi.fn(), "::")).rejects.toThrow("explicit local");
  });
});
