// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager, parseAgentUpdate } from "./agents.js";
import { targetIds } from "./manifest.js";

const directories: string[] = [];
async function directory(): Promise<string> {
  const path = resolve("apps/server/.test-state", randomUUID());
  directories.push(path);
  await mkdir(path, { recursive: true });
  return path;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("agent setup", () => {
  it("rejects arbitrary commands and validates the fixed setup fields", () => {
    expect(() => parseAgentUpdate({ enabled: true, command: "anything" })).toThrow("Expected");
    expect(() => parseAgentUpdate({ enabled: true, executable: "copilot --flag" })).toThrow("absolutePath");
    expect(() => parseAgentUpdate({ enabled: "true" })).toThrow("Expected");
    expect(parseAgentUpdate({ enabled: true, executable: "/usr/bin/copilot", consent: true })).toEqual({
      enabled: true, executable: "/usr/bin/copilot", consent: true,
    });
  });

  it("does not enable a host target without per-target consent", async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const manager = new AgentManager(await directory(), start, vi.fn().mockResolvedValue(undefined));
    await manager.activate();
    await expect(manager.configure("coder-acp-copilot-host", { enabled: true })).rejects.toThrow("consent:true");
    expect(start).not.toHaveBeenCalled();
  });

  it("persists consent and later setup, and exposes asynchronous errors", async () => {
    const path = await directory();
    const manager = new AgentManager(path, vi.fn().mockRejectedValue(new Error("CLI not found")), vi.fn().mockResolvedValue(undefined));
    await manager.activate();
    await manager.configure("coder-acp-copilot-host", { enabled: true, consent: true });
    await vi.waitFor(() => expect(manager.snapshot().busy).toBe(false));
    expect(manager.snapshot().agents.find(item => item.id === "coder-acp-copilot-host")).toMatchObject({
      workerType: "coder-acp-copilot-host", status: "error", enabled: true,
      consent: true, available: false, error: "CLI not found",
    });
    const saved: unknown = JSON.parse(await readFile(`${path}/agents.json`, "utf8"));
    expect(saved).toMatchObject({ "coder-acp-copilot-host": { enabled: true, consent: true } });
    const reloaded = new AgentManager(path, vi.fn().mockResolvedValue(undefined), vi.fn().mockResolvedValue(undefined));
    expect(await reloaded.load()).toBe(true);
    await reloaded.activate();
    expect(reloaded.snapshot().agents.find(item => item.id === "coder-acp-copilot-host")?.available).toBe(true);
  });

  it("serializes setup while allowing status polling", async () => {
    let finish: () => void = () => {};
    const start = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const manager = new AgentManager(await directory(), start, vi.fn().mockResolvedValue(undefined));
    await manager.activate();
    await manager.configure("coder-acp-copilot", { enabled: true });
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(manager.snapshot().busy).toBe(true);
    await expect(manager.configure("coder-acp-claude-code", { enabled: true })).rejects.toThrow("in progress");
    finish();
    await vi.waitFor(() => expect(manager.snapshot().busy).toBe(false));
  });

  it("does not share host consent with the other target", async () => {
    const manager = new AgentManager(await directory(), vi.fn().mockResolvedValue(undefined), vi.fn().mockResolvedValue(undefined));
    manager.choose("coder-acp-copilot-host", true);
    await manager.activate();
    await expect(manager.configure("coder-acp-claude-code-host", { enabled: true })).rejects.toThrow("consent:true");
  });

  it("clears stale availability for unselected targets without starting them", async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);
    const manager = new AgentManager(await directory(), start, stop);
    manager.choose("coder-acp-copilot-host", true);
    await manager.activate();
    expect(stop.mock.calls.map(([id]) => id)).toEqual([...targetIds]);
    expect(start).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledWith("coder-acp-copilot-host", expect.anything());
    expect(manager.controlStatus().agents.filter(agent => agent.available).map(agent => agent.workerType))
      .toEqual(["coder-acp-copilot-host"]);
  });

  it("does not restart or stop a target when its requested setup is unchanged", async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);
    const manager = new AgentManager(await directory(), start, stop);
    await manager.activate();
    stop.mockClear();
    await manager.configure("coder-acp-copilot-host", { enabled: true, consent: true });
    await vi.waitFor(() => expect(manager.snapshot().busy).toBe(false));
    await manager.configure("coder-acp-copilot-host", { enabled: true, consent: true });
    expect(start).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    await manager.configure("coder-acp-copilot-host", { enabled: false });
    await vi.waitFor(() => expect(manager.snapshot().busy).toBe(false));
    await manager.configure("coder-acp-copilot-host", { enabled: false });
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("attempts all agent stops even if one cleanup fails", async () => {
    const stop = vi.fn().mockRejectedValueOnce(new Error("Docker stopped")).mockResolvedValue(undefined);
    const manager = new AgentManager(await directory(), vi.fn(), stop);
    await expect(manager.close()).rejects.toThrow("did not stop");
    expect(stop).toHaveBeenCalledTimes(4);
  });
});
