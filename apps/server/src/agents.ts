// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ConfigureServerAgent, ServerAgentStatus } from "shared/server";
import { isMissing, writeJson } from "./paths.js";
import { isTargetId, targetIds, type TargetId } from "./manifest.js";

export interface AgentSettings {
  enabled: boolean;
  consent: boolean;
  executable?: string;
}

export interface AgentState extends AgentSettings {
  id: TargetId;
  workerType: TargetId;
  label: string;
  runtime: "host" | "docker";
  status: "disabled" | "starting" | "ready" | "error";
  available: boolean;
  version?: string;
  error?: string;
}

export type AgentUpdate = ConfigureServerAgent;

export class SetupError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export function parseAgentUpdate(value: unknown): AgentUpdate {
  if (typeof value !== "object" || value === null || !("enabled" in value) || typeof value.enabled !== "boolean" ||
    ("consent" in value && typeof value.consent !== "boolean") ||
    ("executable" in value && (typeof value.executable !== "string" || !isAbsolute(value.executable))) ||
    Object.keys(value).some(key => !["enabled", "consent", "executable"].includes(key))) {
    throw new SetupError("Expected {enabled:boolean, consent?:boolean, executable?:absolutePath}");
  }
  return value as AgentUpdate;
}

export class AgentManager {
  private readonly states = new Map<TargetId, AgentState>(targetIds.map(id => [id, {
    id, workerType: id,
    label: `${id.includes("copilot") ? "GitHub Copilot" : "Claude Code"} (${id.endsWith("-host") ? "host" : "Docker"})`,
    runtime: id.endsWith("-host") ? "host" : "docker",
    enabled: false, consent: false, status: "disabled", available: false,
  }]));
  private active: Promise<void> | undefined;
  private configuring = false;
  private available = false;
  private closed = false;

  constructor(
    private readonly configDir: string,
    private readonly start: (id: TargetId, settings: AgentSettings) => Promise<{ version?: string; executable?: string } | void>,
    private readonly stop: (id: TargetId) => Promise<void>,
  ) {}

  async load(): Promise<boolean> {
    let value: unknown;
    try { value = JSON.parse(await readFile(join(this.configDir, "agents.json"), "utf8")); }
    catch (error) { if (isMissing(error)) return false; throw error; }
    if (typeof value !== "object" || value === null) throw new Error("Invalid agents.json");
    for (const [id, settings] of Object.entries(value)) {
      if (!isTargetId(id)) throw new Error(`Unknown agent in agents.json: ${id}`);
      const update = parseAgentUpdate(settings);
      if (id.endsWith("-host") && update.enabled && !update.consent) {
        throw new Error(`Host agent ${id} requires saved consent`);
      }
      Object.assign(this.states.get(id)!, update);
    }
    return true;
  }

  snapshot(): { agents: AgentState[]; busy: boolean } {
    return { agents: [...this.states.values()].map(state => ({ ...state })), busy: this.configuring || Boolean(this.active) || !this.available };
  }

  controlStatus(): { agents: ServerAgentStatus[] } {
    return {
      agents: [...this.states.values()].map(state => ({
        workerType: state.workerType,
        label: state.label,
        runtime: state.runtime,
        enabled: state.enabled,
        available: state.available,
        ...(state.executable ? { executable: state.executable } : {}),
        ...(state.version ? { version: state.version } : {}),
        ...(state.error ? { error: state.error } : {}),
      })),
    };
  }

  async persist(): Promise<void> {
    await writeJson(join(this.configDir, "agents.json"), Object.fromEntries([...this.states].map(([id, state]) =>
      [id, { enabled: state.enabled, consent: state.consent, ...(state.executable ? { executable: state.executable } : {}) }])));
  }

  async configure(id: TargetId, update: AgentUpdate): Promise<void> {
    if (this.closed) throw new SetupError("Server is stopping", 503);
    if (!this.available) throw new SetupError("Server is still starting", 503);
    if (this.active || this.configuring) throw new SetupError("Another agent setup is in progress; wait for it to finish", 409);
    const current = this.states.get(id)!;
    if (current.runtime === "host" && update.enabled && !(update.consent ?? current.consent)) {
      throw new SetupError("Enabling a host agent requires consent:true. It runs with your user account, installed CLI and existing login.");
    }
    if (current.runtime === "docker" && update.executable) throw new SetupError("Executable applies only to host agents");
    this.configuring = true;
    try {
      if (update.executable) {
        try { await access(update.executable, constants.X_OK); }
        catch { throw new SetupError(`Executable is missing or not executable: ${update.executable}`); }
      }
      const previous = { ...current };
      const unchanged = current.enabled === update.enabled
        && (!update.executable || update.executable === current.executable)
        && current.status === (update.enabled ? "ready" : "disabled");
      Object.assign(current, update, unchanged ? {} : { status: "starting", available: false, error: undefined });
      try { await this.persist(); }
      catch (error) { Object.assign(current, previous); throw error; }
      if (unchanged) return;
      this.active = this.apply(current).finally(() => { this.active = undefined; });
    } finally {
      this.configuring = false;
    }
  }

  private async apply(state: AgentState): Promise<void> {
    try {
      await this.stop(state.id);
      if (state.enabled) Object.assign(state, await this.start(state.id, state));
      state.status = state.enabled ? "ready" : "disabled";
      state.available = state.enabled;
    } catch (error) {
      state.status = "error";
      state.available = false;
      state.error = error instanceof Error ? error.message : String(error);
    }
  }

  async activate(): Promise<void> {
    for (const state of this.states.values()) {
      state.status = "starting";
      await this.apply(state);
    }
    this.available = true;
  }

  /** Used only by the first-run prompt, before backend startup. */
  choose(id: TargetId, consent: boolean): void {
    if (this.available) throw new Error("Initial choices can only be made before startup");
    const state = this.states.get(id)!;
    if (state.runtime === "host" && !consent) throw new SetupError("Host consent required");
    state.enabled = true;
    state.consent = consent;
  }

  failed(id: TargetId, error: string): void {
    const state = this.states.get(id)!;
    if (state.enabled) { state.status = "error"; state.available = false; state.error = error; }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.active;
    const errors: unknown[] = [];
    for (const state of this.states.values()) {
      try { await this.stop(state.id); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Some agents did not stop cleanly");
  }
}
