// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface MockClient {
  start: ReturnType<typeof vi.fn>;
  ping: ReturnType<typeof vi.fn>;
  listModels: ReturnType<typeof vi.fn>;
  createSession: ReturnType<typeof vi.fn>;
  deleteSession: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  forceStop: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => ({
  clientOptions: [] as Array<Record<string, unknown>>,
  clients: [] as MockClient[],
  mkdir: vi.fn(),
  mkdtemp: vi.fn(),
  rm: vi.fn(),
  ping: vi.fn(),
  models: [{ id: "test-default-model", name: "Test Default", capabilities: {} }],
  sessionFactory: vi.fn(),
}));

interface MockSession {
  sessionId: string;
  on: ReturnType<typeof vi.fn>;
  sendAndWait: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: class implements MockClient {
    start = vi.fn(async () => undefined);
    ping = vi.fn((message: string) => mocks.ping(message));
    listModels = vi.fn(async () => mocks.models);
    createSession = vi.fn((options: Record<string, unknown>) =>
      mocks.sessionFactory(options),
    );
    deleteSession = vi.fn(async () => undefined);
    stop = vi.fn(async () => []);
    forceStop = vi.fn(async () => undefined);

    constructor(options: Record<string, unknown>) {
      mocks.clientOptions.push(options);
      mocks.clients.push(this);
    }
  },
}));

vi.mock("node:fs/promises", () => ({
  mkdir: mocks.mkdir,
  mkdtemp: mocks.mkdtemp,
  rm: mocks.rm,
}));

vi.mock("node:os", () => ({
  tmpdir: () => "/scope-tests",
}));

vi.mock("shared", () => ({
  TokenManagerClient: class {},
  withRetry: <T>(operation: () => Promise<T>) => operation(),
}));

import {
  CopilotCredentialUnavailableError,
  PortalCopilotClientPool,
} from "./copilot-client-pool.js";

const pools: PortalCopilotClientPool[] = [];
let sessionNumber = 0;

function makeSession(overrides: Partial<MockSession> = {}): MockSession {
  const sessionId = `session-${++sessionNumber}`;
  return {
    sessionId,
    on: vi.fn(() => vi.fn()),
    sendAndWait: vi.fn(async () => ({
      data: { content: `response-${sessionId}` },
    })),
    abort: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    ...overrides,
  };
}

function makePool(): PortalCopilotClientPool {
  const tokenClient = {
    acquireToken: vi.fn(async () => "copilot-token"),
  };
  const pool = new PortalCopilotClientPool(
    tokenClient as unknown as ConstructorParameters<typeof PortalCopilotClientPool>[0],
  );
  pools.push(pool);
  return pool;
}

async function complete(pool: PortalCopilotClientPool, suffix = ""): Promise<string> {
  return pool.complete({
    systemPrompt: `system${suffix}`,
    userPrompt: `user${suffix}`,
    model: "test-model",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.clientOptions.length = 0;
  mocks.clients.length = 0;
  mocks.models = [
    { id: "test-default-model", name: "Test Default", capabilities: {} },
  ];
  pools.length = 0;
  sessionNumber = 0;
  vi.stubEnv("PORTAL_COPILOT_POOL_SIZE", "1");
  vi.stubEnv("PATH", "/usr/bin");
  vi.stubEnv("LANG", "en_US.UTF-8");
  vi.stubEnv("HOME", "/sensitive/home");
  vi.stubEnv("GITHUB_TOKEN", "must-not-leak");
  mocks.mkdtemp.mockResolvedValue("/scope-tests/runtime");
  mocks.mkdir.mockResolvedValue(undefined);
  mocks.rm.mockResolvedValue(undefined);
  mocks.ping.mockResolvedValue({ message: "pong" });
  mocks.sessionFactory.mockImplementation(() => makeSession());
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  await Promise.allSettled(pools.map((pool) => pool.shutdown()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("PortalCopilotClientPool", () => {
  it("starts an empty, sanitized runtime and creates a tool-free denied-permission session", async () => {
    const pool = makePool();

    await expect(complete(pool)).resolves.toBe("response-session-1");

    expect(mocks.clientOptions).toHaveLength(1);
    expect(mocks.clientOptions[0]).toMatchObject({
      gitHubToken: "copilot-token",
      useLoggedInUser: false,
      mode: "empty",
      enableRemoteSessions: false,
      env: {
        PATH: "/usr/bin",
        LANG: "en_US.UTF-8",
      },
    });
    expect(mocks.clientOptions[0].env).not.toHaveProperty("HOME");
    expect(mocks.clientOptions[0].env).not.toHaveProperty("GITHUB_TOKEN");

    const sessionOptions = mocks.clients[0].createSession.mock.calls[0][0];
    expect(sessionOptions).toMatchObject({
      model: "test-model",
      availableTools: [],
      excludedTools: ["builtin:*", "mcp:*"],
      tools: [],
      mcpServers: {},
      skillDirectories: [],
      customAgents: [],
      enableConfigDiscovery: false,
      skipCustomInstructions: true,
      requestExtensions: false,
      enableMcpApps: false,
    });
    expect(
      (sessionOptions.onPermissionRequest as () => unknown)(),
    ).toEqual({
      kind: "reject",
      feedback: "Portal AI completions do not permit tool execution.",
    });

    const session = await mocks.clients[0].createSession.mock.results[0].value;
    expect(session.disconnect).toHaveBeenCalledOnce();
    expect(mocks.clients[0].deleteSession).toHaveBeenCalledWith(session.sessionId);
  });

  it("does not release a resource for bounded reuse until its health ping succeeds", async () => {
    let releaseHealthPing: (() => void) | undefined;
    const healthGate = new Promise<void>((resolve) => {
      releaseHealthPing = resolve;
    });
    mocks.ping.mockImplementation(async (message: string) => {
      if (message === "scope-portal-ai-health") await healthGate;
      return { message: "pong" };
    });
    const pool = makePool();

    const first = complete(pool, "-first");
    await vi.waitFor(() => {
      expect(mocks.ping).toHaveBeenCalledWith("scope-portal-ai-health");
    });

    const second = complete(pool, "-second");
    await Promise.resolve();
    expect(mocks.clients).toHaveLength(1);
    expect(mocks.clients[0].createSession).toHaveBeenCalledTimes(1);

    releaseHealthPing?.();
    await expect(Promise.all([first, second])).resolves.toEqual([
      "response-session-1",
      "response-session-2",
    ]);
    expect(mocks.clients).toHaveLength(1);
    expect(mocks.clients[0].createSession).toHaveBeenCalledTimes(2);
  });

  it("invalidates the pooled client when session cleanup fails", async () => {
    const failedCleanupSession = makeSession({
      disconnect: vi.fn(async () => {
        throw new Error("disconnect failed");
      }),
    });
    mocks.sessionFactory
      .mockResolvedValueOnce(failedCleanupSession)
      .mockImplementation(() => makeSession());
    const pool = makePool();

    await expect(complete(pool, "-first")).resolves.toBe(
      `response-${failedCleanupSession.sessionId}`,
    );
    await expect(complete(pool, "-second")).resolves.toBe("response-session-2");

    expect(mocks.clients).toHaveLength(2);
    expect(mocks.clients[0].forceStop).toHaveBeenCalledOnce();
    expect(mocks.clients[1].createSession).toHaveBeenCalledOnce();
  });

  it("drains resources on shutdown and rejects subsequent completions", async () => {
    const pool = makePool();
    await complete(pool);

    await pool.shutdown();

    expect(mocks.clients[0].stop).toHaveBeenCalledOnce();
    expect(mocks.rm).toHaveBeenCalledWith(
      "/scope-tests/runtime",
      { recursive: true, force: true },
    );
    expect(pool.stats()).toEqual({
      used: 0,
      free: 0,
      pendingAcquires: 0,
      pendingCreates: 0,
      resources: 0,
      resourcesCreated: 1,
      sessionsCreated: 1,
      sessionsDeleted: 1,
    });
    await expect(complete(pool)).rejects.toThrow(
      "Copilot SDK pool is shutting down",
    );
  });

  it("treats an account with no Copilot models as an unavailable credential", async () => {
    mocks.models = [];
    const pool = makePool();

    await expect(complete(pool)).rejects.toBeInstanceOf(
      CopilotCredentialUnavailableError,
    );
    expect(mocks.clients[0].forceStop).toHaveBeenCalledOnce();
    expect(mocks.rm).toHaveBeenCalledWith(
      "/scope-tests/runtime",
      { recursive: true, force: true },
    );
  });
});
