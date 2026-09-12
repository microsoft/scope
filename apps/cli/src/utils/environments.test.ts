// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "dotenv";
import { registerEnvCommands } from "../commands/env.js";
import { registerProjectCommands } from "../commands/project.js";
import { registerRunCommands } from "../commands/run.js";
import { registerReportCommands } from "../commands/report.js";
import { registerMcpCommands } from "../commands/mcp.js";
import { registerCodebaseCommands } from "../commands/codebase.js";
import { registerAgentCommands } from "../commands/agent.js";
import { ScopeCommand, currentEnvironment } from "./connection.js";
import { EnvironmentStore, environmentConfigDir } from "./environments.js";
import { apiFetch, apiEventSource, resetApiClient, setReauthHandler, setTokenProvider } from "./api-client.js";
import { resolveProjectId, setSelectedProjectId } from "./config.js";
import { getDefaultApiUrl, applyApiPortFallback } from "./shared.js";

const isolated = vi.hoisted(() => ({
  home: `${process.cwd()}/apps/cli/.test-environments-${process.pid}`,
  streams: [] as Array<{ url: string; options?: { headers?: Record<string, string> } }>,
}));
vi.mock("node:os", async (original) => ({
  ...await original<typeof import("node:os")>(),
  homedir: () => isolated.home,
}));
vi.mock("eventsource", () => ({
  default: class {
    constructor(url: string, options?: { headers?: Record<string, string> }) { isolated.streams.push({ url, options }); }
    addEventListener(): void {}
    close(): void {}
  },
}));

interface CapturedRequest { url: string; token: string | null; method: string; body: string }
let requests: CapturedRequest[];
let store: EnvironmentStore;
let reply: (request: Request) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function cli(): ScopeCommand {
  const program = new ScopeCommand().option("--env <name>").exitOverride();
  registerEnvCommands(program);
  registerProjectCommands(program);
  registerRunCommands(program);
  registerReportCommands(program);
  registerMcpCommands(program);
  registerCodebaseCommands(program);
  registerAgentCommands(program);
  return program;
}

async function run(...args: string[]): Promise<void> {
  await cli().parseAsync(args, { from: "user" });
}

beforeEach(() => {
  rmSync(isolated.home, { recursive: true, force: true });
  mkdirSync(isolated.home, { recursive: true });
  vi.stubEnv("XDG_CONFIG_HOME", join(isolated.home, "xdg"));
  vi.stubEnv("LOCALAPPDATA", join(isolated.home, "appdata"));
  vi.stubEnv("SCOPE_API_URL", "https://legacy.example");
  vi.stubEnv("SCOPE_TOKEN", "ambient-token");
  vi.stubEnv("SCOPE_PROJECT", "ambient-project");
  vi.stubEnv("SCOPE_DEFAULT_API_URL", "");
  vi.stubEnv("SCOPE_API_PORT", "");
  store = new EnvironmentStore();
  store.add("local", "http://127.0.0.1:43127", "local-token");
  store.set("local", "SCOPE_PROJECT", "local-project");
  store.add("staging", "https://staging.example", "staging-token");
  store.set("staging", "SCOPE_PROJECT", "staging-project");
  setSelectedProjectId("legacy-project");
  resetApiClient();
  requests = [];
  isolated.streams.length = 0;
  reply = () => json([]);
  vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
    requests.push({ url: request.url, token: request.headers.get("authorization"), method: request.method, body: await request.clone().text() });
    return reply(request);
  }));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => { throw new Error(`Unexpected process.exit(${code})`); });
});

afterEach(() => {
  resetApiClient();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(isolated.home, { recursive: true, force: true });
});

describe("named environment commands and isolated storage", () => {
  it("adds, lists, shows, selects, edits, unsets, clears and removes through Commander", async () => {
    await run("env", "add", "production", "--url", "https://production.example/", "--token", "private # token");
    await run("env", "use", "production");
    expect(store.active()).toBe("production");
    await run("env", "set", "project", "prod-project");
    await run("--env", "local", "env", "set", "SCOPE_TOKEN", "changed-token");
    expect(store.read("production").project).toBe("prod-project");
    expect(store.read("local").token).toBe("changed-token");
    await run("env", "list", "-o", "json");
    await run("env", "show", "-o", "json");
    await run("env", "show", "local", "-o", "json");
    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("private # token");
    expect(output).not.toContain("changed-token");
    await run("env", "unset", "token");
    expect(store.read("production").token).toBeUndefined();
    await run("env", "use", "--clear");
    expect(store.active()).toBeUndefined();
    await run("env", "use", "production");
    await run("env", "remove", "production");
    expect(store.active()).toBeUndefined();
    expect(() => store.read("production")).toThrow("does not exist");
    expect(requests).toHaveLength(0);
  });

  it("keeps legacy configuration in its existing path, separate from the named store", () => {
    expect(JSON.parse(readFileSync(join(isolated.home, ".config/scope/config.json"), "utf8"))).toEqual({ selectedProjectId: "legacy-project" });
    expect(store.directory).toBe(join(isolated.home, "xdg", "scope"));
    const file = join(store.directory, "environments/local.env");
    expect(parse(readFileSync(file, "utf8"))).toEqual({ SCOPE_API_URL: "http://127.0.0.1:43127", SCOPE_TOKEN: "local-token", SCOPE_PROJECT: "local-project" });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(environmentConfigDir({}, "darwin", "/home/test")).toBe("/home/test/.config/scope");
    expect(environmentConfigDir({ XDG_CONFIG_HOME: "/config" }, "linux", "/home/test")).toBe("/config/scope");
    expect(environmentConfigDir({ LOCALAPPDATA: "/appdata" }, "win32", "/home/test")).toBe("/appdata/scope");
  });

  it("rejects unsafe names/URLs, duplicate creation, ambiguous selection and URL removal", async () => {
    for (const name of ["../outside", "/absolute", "a/b", "CON", ""]) {
      expect(() => store.add(name, "https://example.com")).toThrow();
    }
    for (const url of ["file:///etc/passwd", "not-a-url", "https://secret@example.com", "https://example.com/?token=x"]) {
      expect(() => store.add("invalid", url)).toThrow();
    }
    await expect(run("env", "add", "local", "--url", "https://other.example")).rejects.toThrow("already exists");
    await expect(run("env", "use", "local", "--clear")).rejects.toThrow("not both");
    await expect(run("--env", "local", "env", "unset", "url")).rejects.toThrow("requires its URL");
    await expect(run("--env", "local", "env", "set", "PATH", "override")).rejects.toThrow("Unknown environment key");
  });

  it("replaces an existing environment only when --force is given", async () => {
    store.add("dup", "https://first.example", "first-token");
    store.set("dup", "SCOPE_PROJECT", "keep-me");
    expect(() => store.add("dup", "https://second.example")).toThrow("already exists");
    // The refusal must not have modified anything.
    expect(store.read("dup").url).toBe("https://first.example");
    expect(store.read("dup").project).toBe("keep-me");

    await run("env", "add", "dup", "--url", "https://second.example", "--force");
    const replaced = store.read("dup");
    expect(replaced.url).toBe("https://second.example");
    // --force replaces the whole entry rather than merging, so stale values go.
    expect(replaced.token).toBeUndefined();
    expect(replaced.project).toBeUndefined();
    // Name validation still applies with --force.
    expect(() => store.add("../outside", "https://example.com", undefined, true)).toThrow();
  });
});

describe("integrated environment resolution and precedence", () => {
  it("pins saved URL/token/project, with root --env overriding only this invocation", async () => {
    store.use("local");
    await run("run", "list", "-o", "json");
    await run("--env", "staging", "run", "list", "-o", "json");
    expect(requests.map((r) => [new URL(r.url).origin, new URL(r.url).searchParams.get("projectId"), r.token])).toEqual([
      ["http://127.0.0.1:43127", "local-project", "Bearer local-token"],
      ["https://staging.example", "staging-project", "Bearer staging-token"],
    ]);
    expect(store.active()).toBe("local");
    expect(currentEnvironment()).toBeUndefined();
    expect(process.env.SCOPE_API_URL).toBe("https://legacy.example");
  });

  it.each(["--url", "-u"])("explicit caller API %s restores legacy auth/project even when equal to the default", async (flag) => {
    store.use("local");
    await run("--env", "missing", "run", "list", flag, getDefaultApiUrl(), "-o", "json");
    expect(requests[0]).toMatchObject({ token: "Bearer ambient-token" });
    expect(new URL(requests[0].url).origin).toBe("https://legacy.example");
    expect(new URL(requests[0].url).searchParams.get("projectId")).toBe("ambient-project");
    vi.stubEnv("SCOPE_PROJECT", "");
    await run("run", "list", flag, "https://other.example", "-o", "json");
    expect(new URL(requests[1].url).searchParams.get("projectId")).toBe("legacy-project");
  });

  it("uses legacy environment/port/build defaults only when neither named selector exists", async () => {
    await run("project", "list", "-o", "json");
    expect(requests[0].url).toBe("https://legacy.example/api/v1/projects");
    vi.stubEnv("SCOPE_API_URL", "");
    vi.stubEnv("SCOPE_API_PORT", "3999");
    applyApiPortFallback();
    await run("project", "list", "-o", "json");
    expect(requests[1].url).toBe("http://localhost:3999/api/v1/projects");
    vi.stubEnv("SCOPE_API_URL", "");
    vi.stubEnv("SCOPE_DEFAULT_API_URL", "https://bundled.example");
    await run("project", "list", "-o", "json");
    expect(requests[2].url).toBe("https://bundled.example/api/v1/projects");
    vi.stubEnv("SCOPE_DEFAULT_API_URL", "");
    await run("project", "list", "-o", "json");
    expect(requests[3].url).toBe("http://localhost:3100/api/v1/projects");
  });

  it("never borrows absent named credentials or project, including from custom auth", async () => {
    store.add("anonymous", "http://127.0.0.1:4000");
    const provider = vi.fn(() => "provider-token");
    const reauth = vi.fn(() => true);
    setTokenProvider(provider);
    setReauthHandler(reauth);
    await run("--env", "anonymous", "project", "list", "-o", "json");
    expect(requests[0].token).toBeNull();
    expect(provider).not.toHaveBeenCalled();
    await expect(run("--env", "anonymous", "run", "list")).rejects.toThrow("No project selected");
    expect(requests).toHaveLength(1);
    await run("--env", "anonymous", "run", "list", "--project", "explicit-project", "-o", "json");
    expect(new URL(requests[1].url).searchParams.get("projectId")).toBe("explicit-project");
    const program = new ScopeCommand().option("--env <name>");
    program.command("check").option("-u, --url <url>", "API", getDefaultApiUrl()).action(async (options: { url: string }) => {
      expect((await apiFetch(options.url, "/private")).status).toBe(401);
    });
    reply = () => json({ error: "unauthorized" }, 401);
    await program.parseAsync(["--env", "anonymous", "check"], { from: "user" });
    expect(reauth).not.toHaveBeenCalled();
    expect(requests).toHaveLength(3);
  });

  it("fails a missing or malformed named selection rather than contacting a legacy server", async () => {
    await expect(run("--env", "missing", "project", "list")).rejects.toThrow("does not exist");
    writeFileSync(join(store.directory, "environments/local.env"), "SCOPE_TOKEN=only-token\n");
    await expect(run("--env", "local", "project", "list")).rejects.toThrow("has no SCOPE_API_URL");
    expect(requests).toHaveLength(0);
    await run("--env", "local", "project", "list", "--url", "https://explicit.example");
    expect(requests).toHaveLength(1);
    await run("--env", "local", "env", "set", "url", "https://repaired.example");
    expect(store.read("local")).toMatchObject({ url: "https://repaired.example", token: "only-token" });
  });

  it("writes project selection only to the targeted environment; explicit URL retains legacy persistence", async () => {
    reply = () => json({ _id: "chosen", name: "Chosen", createdAt: "2026-01-01" });
    store.use("local");
    await run("--env", "staging", "project", "use", "chosen");
    expect(store.read("staging").project).toBe("chosen");
    expect(store.read("local").project).toBe("local-project");
    expect(resolveProjectId()).toBe("ambient-project");
    await run("project", "use", "chosen", "-u", "https://legacy.example");
    expect(JSON.parse(readFileSync(join(isolated.home, ".config/scope/config.json"), "utf8"))).toEqual({ selectedProjectId: "chosen" });
  });

  it.each(["create", "update"])("MCP %s keeps resource --url and process --env independent from root/API selectors", async (action) => {
    store.use("staging");
    reply = () => json({ _id: "test" });
    const args = action === "create" ? ["--id", "test", "--name", "Test", "--type", "http"] : ["--id", "test"];
    await run("--env", "local", "mcp", "server", action, ...args, "--url", "https://mcp.example", "--env", "FOO=bar");
    expect(requests[0].url).toContain("http://127.0.0.1:43127/api/v1/mcp/servers");
    expect(requests[0].token).toBe("Bearer local-token");
    const body: { url: string; env?: Record<string, string> } = JSON.parse(requests[0].body);
    expect(body.url).toBe("https://mcp.example");
    if (action === "update") expect(body.env).toEqual({ FOO: "bar" });
    for (const apiFlag of ["--api-url", "-u"]) {
      await run("--env", "missing", "mcp", "server", action, ...args, "--url", "https://mcp.example", apiFlag, getDefaultApiUrl());
      expect(requests.at(-1)?.token).toBe("Bearer ambient-token");
      expect(requests.at(-1)?.url).toContain("https://legacy.example/api/v1/mcp/servers");
    }
  });

  it("MCP stdio process environment does not select a named connection", async () => {
    store.use("local");
    reply = () => json({ _id: "stdio" });
    await run("mcp", "server", "create", "--id", "stdio", "--name", "Stdio", "--type", "stdio", "--command", "node", "--env", "FOO=bar", "BAR=baz");
    expect(requests[0].token).toBe("Bearer local-token");
    const body: { env: Record<string, string> } = JSON.parse(requests[0].body);
    expect(body.env).toEqual({ FOO: "bar", BAR: "baz" });
  });

  it("routes codebase list and scoped slug resolution through the same named transport", async () => {
    store.use("local");
    await run("codebase", "list", "-o", "json");
    reply = (request) => request.url.includes("/revisions")
      ? json([])
      : json({ _id: "codebase-id", slug: "slug", name: "Codebase" });
    await run("codebase", "revisions", "slug", "-o", "json");
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(new URL(request.url).origin).toBe("http://127.0.0.1:43127");
      expect(new URL(request.url).searchParams.get("projectId")).toBe("local-project");
      expect(request.token).toBe("Bearer local-token");
    }
  });
});

describe("operation pinning across streams, downloads, polling and retry", () => {
  it("uses the named connection for the real retry command", async () => {
    store.use("local");
    reply = () => json({ requestId: "request", runId: "retried", attemptNumber: 2 });
    await run("run", "retry", "-i", "request", "--force");
    expect(requests[0]).toMatchObject({
      url: "http://127.0.0.1:43127/api/v1/requests/request/retry",
      token: "Bearer local-token",
      method: "POST",
    });
    expect(JSON.parse(requests[0].body)).toMatchObject({ force: true });
  });

  describe("local agent status/setup CLI parity", () => {
      const status = {
        enabled: true,
        agents: [{
          workerType: "coder-acp-copilot-host",
          label: "Copilot (host)",
          runtime: "host",
          enabled: true,
          available: true,
          executable: "/installed/copilot",
          version: "1.0.0",
        }],
      };

      it("shows discovery/status using the selected environment, without requiring a project", async () => {
        store.set("local", "SCOPE_PROJECT");
        reply = () => json(status);
        await run("--env", "local", "agent", "status", "-o", "json");
        expect(requests[0]).toMatchObject({
          url: "http://127.0.0.1:43127/api/v1/server", token: "Bearer local-token", method: "GET",
        });
        expect(JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]))).toEqual(status);
      });

      it("enables a host target with only the explicit executable and consent fields", async () => {
        reply = () => json(status);
        await run("--env", "local", "agent", "setup", "coder-acp-copilot-host", "--enable", "--executable", "/installed/copilot", "--consent", "-o", "json");
        expect(requests[0]).toMatchObject({
          url: "http://127.0.0.1:43127/api/v1/server/agents/coder-acp-copilot-host",
          token: "Bearer local-token", method: "PUT",
        });
        expect(JSON.parse(requests[0].body)).toEqual({ enabled: true, executable: "/installed/copilot", consent: true });
      });

      it("disables a target through the explicit URL's legacy connection", async () => {
        store.use("local");
        reply = () => json(status);
        await run("--env", "missing", "agent", "setup", "coder-acp-claude-code", "--disable", "-u", "https://explicit.example");
        expect(requests[0]).toMatchObject({
          url: "https://explicit.example/api/v1/server/agents/coder-acp-claude-code",
          token: "Bearer ambient-token", method: "PUT",
        });
        expect(JSON.parse(requests[0].body)).toEqual({ enabled: false });
      });

      it.each([
        ["unsupported", "--enable"],
        ["coder-acp-copilot-host"],
        ["coder-acp-copilot-host", "--enable", "--disable"],
        ["coder-acp-copilot", "--enable", "--consent"],
        ["coder-acp-copilot-host", "--disable", "--executable", "/installed/copilot"],
      ])("rejects invalid setup arguments before mutation: %s", async (...args) => {
        await expect(run("--env", "local", "agent", "setup", ...args)).rejects.toThrow();
        expect(requests).toHaveLength(0);
      });

      it("reports disabled local setup and does not invent a separate login", async () => {
        reply = () => json({ enabled: false, agents: [] });
        await run("--env", "local", "agent", "status");
        expect(vi.mocked(console.log).mock.calls.flat().join(" ")).toContain("not enabled");
        expect(requests).toHaveLength(1);
      });

      it("surfaces setup errors without automatically replaying a process-starting mutation", async () => {
        reply = () => json({ error: "Worker setup is in progress" }, 503);
        await expect(run("--env", "local", "agent", "setup", "coder-acp-copilot", "--enable")).rejects.toThrow("Worker setup is in progress");
        expect(requests).toHaveLength(1);
      });

      it("retries a transient status failure without changing the selected connection", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        reply = () => {
          if (requests.length === 1) {
            store.use("staging");
            return json({ error: "Unavailable" }, 503);
          }
          return json(status);
        };
        await run("--env", "local", "agent", "status", "-o", "json");
        expect(requests).toHaveLength(2);
        expect(requests.every((request) => request.token === "Bearer local-token" && request.url === "http://127.0.0.1:43127/api/v1/server")).toBe(true);
      });

      it("optionally waits for readiness by polling GET without replaying PUT or switching environment", async () => {
        reply = (request) => {
          if (request.method === "PUT") {
            store.use("staging");
            store.set("local", "SCOPE_TOKEN", "edited-token");
            return json({ ...status, agents: [{ ...status.agents[0], available: false }] });
          }
          return json(status);
        };
        await run("--env", "local", "agent", "setup", "coder-acp-copilot-host", "--enable", "--wait", "-o", "json");
        expect(requests.map((request) => request.method)).toEqual(["PUT", "GET"]);
        expect(requests.every((request) => request.url.startsWith("http://127.0.0.1:43127/") && request.token === "Bearer local-token")).toBe(true);
        expect(JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]))).toEqual(status);
      });

      it("retries ky-wrapped network failures on the pinned status connection", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        reply = () => {
          if (requests.length === 1) {
            store.use("staging");
            throw new TypeError("fetch failed");
          }
          return json(status);
        };
        await run("--env", "local", "agent", "status", "-o", "json");
        expect(requests).toHaveLength(2);
        expect(requests.every(request => request.url === "http://127.0.0.1:43127/api/v1/server")).toBe(true);
      });

      it("does not replay a setup mutation after a network failure", async () => {
        reply = () => { throw new TypeError("fetch failed"); };
        await expect(run("--env", "local", "agent", "setup", "coder-acp-copilot-host", "--enable")).rejects.toThrow();
        expect(requests.map(request => request.method)).toEqual(["PUT"]);
      });

      it("surfaces asynchronous startup errors while waiting", async () => {
        reply = (request) => json({
          ...status,
          agents: [{ ...status.agents[0], available: false, ...(request.method === "GET" ? { error: "Installed CLI login is required" } : {}) }],
        });
        await expect(run("--env", "local", "agent", "setup", "coder-acp-copilot-host", "--enable", "--wait")).rejects.toThrow("Installed CLI login is required");
        expect(requests.map((request) => request.method)).toEqual(["PUT", "GET"]);
      });

      it("bounds waiting and never automatically resubmits a timed-out setup", async () => {
        reply = () => json({ ...status, agents: [{ ...status.agents[0], available: false }] });
        vi.useFakeTimers();
        try {
          const timeout = expect(run("--env", "local", "agent", "setup", "coder-acp-copilot-host", "--enable", "--wait", "--timeout", "0.001")).rejects.toThrow("Timed out waiting");
          await vi.runAllTimersAsync();
          await timeout;
        } finally {
          vi.useRealTimers();
        }
        expect(requests.map((request) => request.method)).toEqual(["PUT"]);
        await expect(run("--env", "local", "agent", "setup", "coder-acp-copilot-host", "--enable", "--timeout", "0")).rejects.toThrow("positive number");
        expect(requests).toHaveLength(1);
      });
    });
  it("pins real run/report SSE URLs and headers while preserving explicit-URL legacy SSE", async () => {
    store.use("local");
    await run("run", "logs", "-i", "request", "--from-start");
    reply = () => json({ id: "report" });
    await run("report", "logs", "-i", "report");
    await run("run", "logs", "-i", "request", "-u", "https://explicit.example");
    expect(isolated.streams).toEqual([
      { url: "http://127.0.0.1:43127/api/v1/requests/request/logs?fromStart=true", options: { headers: { Authorization: "Bearer local-token" } } },
      { url: "http://127.0.0.1:43127/api/v1/reports/report/logs", options: { headers: { Authorization: "Bearer local-token" } } },
      { url: "https://explicit.example/api/v1/requests/request/logs", options: undefined },
    ]);
  });

  it("keeps a download on the original connection even if selection, disk and ambient credentials change", async () => {
    store.use("local");
    reply = (request) => {
      if (request.url.endsWith("/archive")) return new Response("archive-bytes");
      store.use("staging");
      store.set("local", "SCOPE_TOKEN", "edited");
      store.set("local", "SCOPE_API_URL", "https://edited.example");
      process.env.SCOPE_TOKEN = "edited-ambient";
      return json({ workerType: "test", run: { status: "done", turns: [{}] } });
    };
    const file = join(isolated.home, "download.tar.gz");
    await run("run", "download", "-i", "request", "-o", file);
    expect(readFileSync(file, "utf8")).toBe("archive-bytes");
    expect(requests.map((request) => request.token)).toEqual(["Bearer local-token", "Bearer local-token"]);
    expect(requests.every((request) => request.url.startsWith("http://127.0.0.1:43127/"))).toBe(true);
  });

  it("retains independent action contexts for asynchronous polling/retry callbacks after action return", async () => {
    let finish: Promise<void> | undefined;
    const program = new ScopeCommand().option("--env <name>");
    program.command("poll").option("-u, --url <url>", "API", getDefaultApiUrl())
      .action((options: { url: string }) => {
        finish = new Promise<void>((resolve, reject) => {
          setTimeout(() => {
            void (async () => {
              await apiFetch(options.url, "/poll", { projectId: resolveProjectId() });
              await apiFetch(options.url, "/retry", { projectId: resolveProjectId() });
              await apiEventSource(options.url, "/events");
            })().then(resolve, reject);
          }, 0);
        });
      });
    await program.parseAsync(["--env", "local", "poll"], { from: "user" });
    store.use("staging");
    store.set("local", "SCOPE_PROJECT", "changed-on-disk");
    expect(currentEnvironment()).toBeUndefined();
    await finish;
    expect(requests.every((request) => request.token === "Bearer local-token" && new URL(request.url).searchParams.get("projectId") === "local-project")).toBe(true);
    expect(isolated.streams[0].url).toBe("http://127.0.0.1:43127/api/v1/events");
  });
});
