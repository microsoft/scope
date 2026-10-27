// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerTaskPromptCommands } from "./task-prompt.js";

function makeProgram(): Command {
  const program = new Command();
  registerTaskPromptCommands(program);
  return program;
}

/** Captures the outgoing request that the `ky` engine handed to `fetch`. */
interface CapturedRequest {
  url: string;
  method: string;
  body: string;
}

let lastRequest: CapturedRequest | undefined;

function mockFetchWith(body: unknown): void {
  lastRequest = undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (req: Request) => {
      // `ky` calls `fetch(request)` with a single `Request`; capture it before the body is consumed.
      lastRequest = { url: req.url, method: req.method, body: await req.text() };
      return { ok: true, status: 200, json: async () => body };
    }),
  );
}

describe("task-prompt list", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("passes --type as a query param", async () => {
    mockFetchWith({ items: [], total: 0 });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const program = makeProgram();
      await program.parseAsync(
        ["task-prompt", "list", "--type", "agents.md", "-u", "http://localhost:3100", "--project", "proj-test"],
        { from: "user" },
      );
    } finally {
      logSpy.mockRestore();
    }

    expect(lastRequest?.url).toContain("type=agents.md");
    expect(lastRequest?.url).toContain("projectId=proj-test");
  });

  it("renders blob-backed prompts without crashing on missing text", async () => {
    mockFetchWith({
      items: [{ _id: "abcdef1234", type: "agents.md", contentBlobUrl: "prompts/abcdef1234.txt", createdAt: new Date().toISOString() }],
      total: 1,
    });
    const lines: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...p: unknown[]) => {
      lines.push(p.map(String).join(" "));
    });

    try {
      const program = makeProgram();
      await program.parseAsync(["task-prompt", "list", "-u", "http://localhost:3100", "--project", "proj-test"], { from: "user" });
    } finally {
      logSpy.mockRestore();
    }

    const output = lines.join("\n");
    expect(output).toContain("agents.md");
    expect(output).toContain("(blob)");
  });
});

describe("task-prompt create", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("sends type in the create body when provided", async () => {
    mockFetchWith({ _id: "id-1", type: "agents.md", createdAt: new Date().toISOString() });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const program = makeProgram();
      await program.parseAsync(
        ["task-prompt", "create", "-t", "# Guidance", "--type", "agents.md", "-u", "http://localhost:3100", "--project", "proj-test"],
        { from: "user" },
      );
    } finally {
      logSpy.mockRestore();
    }

    expect(JSON.parse(lastRequest!.body)).toEqual({ text: "# Guidance", type: "agents.md" });
    expect(lastRequest!.url).toContain("projectId=proj-test");
  });

  it("defaults type to select when not provided", async () => {
    mockFetchWith({ _id: "id-2", createdAt: new Date().toISOString() });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const program = makeProgram();
      await program.parseAsync(
        ["task-prompt", "create", "-t", "plain task", "-u", "http://localhost:3100", "--project", "proj-test"],
        { from: "user" },
      );
    } finally {
      logSpy.mockRestore();
    }

    expect(JSON.parse(lastRequest!.body)).toEqual({ text: "plain task", type: "select" });
    expect(lastRequest!.url).toContain("projectId=proj-test");
  });
});

/** Run the CLI with console.log captured; returns the printed lines. */
async function runCli(args: string[]): Promise<string[]> {
  const lines: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...p: unknown[]) => {
    lines.push(p.map(String).join(" "));
  });
  try {
    await makeProgram().parseAsync(args, { from: "user" });
  } finally {
    logSpy.mockRestore();
  }
  return lines;
}

describe("task-prompt name (#176)", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("create --name sends the name", async () => {
    mockFetchWith({ _id: "id-3", name: "order-api", createdAt: new Date().toISOString() });

    const lines = await runCli(
      ["task-prompt", "create", "-t", "Build an order API", "--name", "order-api", "-u", "http://localhost:3100", "--project", "proj-test"],
    );

    expect(JSON.parse(lastRequest!.body)).toEqual({ text: "Build an order API", type: "select", name: "order-api" });
    expect(lines.join("\n")).toContain("order-api");
  });

  it("list shows the name column", async () => {
    mockFetchWith({
      items: [{ _id: "abcdef1234", name: "order-api", text: "Build an order API", createdAt: new Date().toISOString() }],
      total: 1,
    });

    const lines = await runCli(["task-prompt", "list", "-u", "http://localhost:3100", "--project", "proj-test"]);

    const output = lines.join("\n");
    expect(output).toContain("Name");
    expect(output).toContain("order-api");
  });

  it("rename --name PATCHes the new name", async () => {
    mockFetchWith({ _id: "id-4", name: "new-name" });

    const lines = await runCli(["task-prompt", "rename", "-i", "id-4", "--name", "new-name", "-u", "http://localhost:3100"]);

    expect(lastRequest!.method).toBe("PATCH");
    expect(lastRequest!.url).toContain("/task-prompts/id-4");
    expect(JSON.parse(lastRequest!.body)).toEqual({ name: "new-name" });
    expect(lines.join("\n")).toContain('renamed to "new-name"');
  });

  it("rename --clear sends name: null", async () => {
    mockFetchWith({ _id: "id-4" });

    const lines = await runCli(["task-prompt", "rename", "-i", "id-4", "--clear", "-u", "http://localhost:3100"]);

    expect(JSON.parse(lastRequest!.body)).toEqual({ name: null });
    expect(lines.join("\n")).toContain("Name cleared");
  });

  it("rename requires exactly one of --name or --clear", async () => {
    mockFetchWith({});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runCli(["task-prompt", "rename", "-i", "id-4", "-u", "http://localhost:3100"])).rejects.toThrow("exit");
    expect(lastRequest).toBeUndefined();

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});
