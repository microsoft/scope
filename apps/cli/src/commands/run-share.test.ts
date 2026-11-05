// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FULL_SHARE_CONTENT, SUMMARY_SHARE_CONTENT, RUN_SHARE_HEADER, type RunShare, type RunShareLink } from "shared/run-sharing";
import { registerRunCommands } from "./run.js";
import { resetApiClient, setApiLogSink, setReauthHandler, type ApiLogEntry } from "../utils/api-client.js";

const shareId = "11111111-2222-4333-8444-555555555555";
const token = `${shareId}.${"A".repeat(43)}`;
const share: RunShare = {
  id: shareId, requestId: "request-1", runId: "attempt-1", label: "Shared run",
  content: { ...SUMMARY_SHARE_CONTENT }, expiresAt: null, revokedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};
let captured: Request[] = [];
let bodies: unknown[] = [];
let output: string[] = [];
let response: unknown;
const run = (args: string[]) => {
  const program = new Command();
  registerRunCommands(program);
  return program.parseAsync(["run", "share", ...args], { from: "user" });
};
const common = ["-u", "https://scope.test", "--attempt", "attempt-1", "-o", "json"];

beforeEach(() => {
  resetApiClient();
  captured = [];
  bodies = [];
  output = [];
  response = { share, path: `/shared/runs#${token}` };
  vi.stubEnv("SCOPE_TOKEN", "idp-token");
  vi.stubEnv("SCOPE_API_URL", "");
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => output.push(args.map(String).join(" ")));
  vi.stubGlobal("fetch", vi.fn(async (req: Request) => {
    captured.push(req);
    const text = await req.text();
    const body: unknown = text ? JSON.parse(text) : undefined;
    bodies.push(body);
    return new Response(JSON.stringify(response), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetApiClient(); });

describe("run share CLI parity", () => {
  it("creates a Summary link with an explicit attempt and no expiry", async () => {
    await run(["create", "request-1", ...common, "--no-expiry", "--portal-url", "https://portal.test"]);
    expect(captured[0].url).toBe("https://scope.test/api/v1/requests/request-1/runs/attempt-1/shares");
    expect(captured[0].headers.get("authorization")).toBe("Bearer idp-token");
    expect(bodies[0]).toMatchObject({ content: SUMMARY_SHARE_CONTENT, expiresAt: null });
    const created: RunShareLink = JSON.parse(output[0]);
    expect(created.path).toBe(`https://portal.test/shared/runs#${token}`);
  });

  it("supports configurable Full detail with explicit raw artifact flags", async () => {
    await run(["create", "request-1", ...common, "--preset", "full", "--include", "snapshots,network,video", "--exclude", "logs", "--acknowledge-sensitive-content"]);
    expect(bodies[0]).toMatchObject({
      content: { ...FULL_SHARE_CONTENT, snapshots: true, network: true, video: true, logs: false },
      acknowledgeSensitiveContent: true,
    });
  });

  it("keeps TSV output machine-readable and includes the one-time URL as a column", async () => {
    await run(["create", "request-1", ...common, "--output", "tsv"]);
    expect(output).toHaveLength(1);
    expect(output[0]).toContain("\t");
    expect(output[0]).toContain(`/shared/runs#${token}`);
    expect(output[0]).not.toContain("Shared URL:");
  });

  it("fails before I/O for unconfirmed detailed sharing or invalid policy categories", async () => {
    await expect(run(["create", "request-1", ...common, "--preset", "full"])).rejects.toThrow(/Confirm/);
    await expect(run(["create", "request-1", ...common, "--include", "secret"])).rejects.toThrow("Unknown shared content category");
    await expect(run(["update", "request-1", shareId, ...common, "--include", "logs"])).rejects.toThrow("--preset");
    expect(captured).toHaveLength(0);
  });

  it("updates and lists links with pagination and preserves machine-readable response shapes", async () => {
    response = { ...share, label: "Updated" };
    await run(["update", "request-1", shareId, ...common, "--label", "Updated", "--expires-at", "2099-01-01T00:00:00.000Z"]);
    expect(captured[0].method).toBe("PATCH");
    expect(bodies[0]).toEqual({ label: "Updated", expiresAt: "2099-01-01T00:00:00.000Z" });
    response = { data: [share], next: null };
    await run(["list", "request-1", ...common, "--after", shareId]);
    expect(captured[1].url).toContain(`?after=${shareId}`);
    expect(JSON.parse(output[1])).toEqual(response);
  });

  it("rotates and revokes links through their lifecycle endpoints", async () => {
    await run(["rotate", "request-1", shareId, ...common]);
    expect(captured[0].url).toContain(`/shares/${shareId}/rotate`);
    expect(captured[0].method).toBe("POST");
    response = { ...share, revokedAt: "2026-01-02T00:00:00.000Z" };
    await run(["revoke", "request-1", shareId, ...common]);
    expect(captured[1].method).toBe("DELETE");
  });

  it("views a shared URL without IdP credentials or secrets in request URLs/debug logs", async () => {
    response = {
      version: 1, label: "Shared result", content: SUMMARY_SHARE_CONTENT, expiresAt: null,
      run: { attemptNumber: 1, status: "done", workerType: "worker", turns: [] }, artifacts: [],
    };
    const logs: ApiLogEntry[] = [];
    setApiLogSink({ record: (entry) => logs.push(entry) });
    await run(["view", `https://portal.test/shared/runs#${token}`]);
    expect(captured[0].url).toBe("https://portal.test/api/v1/shared/runs/view");
    expect(captured[0].headers.has("authorization")).toBe(false);
    expect(captured[0].headers.get(RUN_SHARE_HEADER)).toBe(token);
    expect(captured[0].credentials).toBe("omit");
    expect(JSON.stringify(logs)).not.toContain(token);
    expect(JSON.stringify(logs)).not.toContain("idp-token");
    expect(JSON.parse(output[0])).toEqual(response);
  });

  it("can read shared logs and report pages without invoking reauthentication", async () => {
    const reauth = vi.fn(async () => false);
    setReauthHandler(reauth);
    response = { events: [], truncated: true };
    await run(["view", token, "-u", "https://scope.test", "--section", "logs"]);
    expect(JSON.parse(output[0])).toEqual(response);
    response = { data: [], next: null };
    await run(["view", token, "-u", "https://scope.test", "--section", "reports", "--after", shareId]);
    expect(captured[1].url).toContain(`/reports?after=${shareId}`);
    expect(reauth).not.toHaveBeenCalled();
    expect(captured.every((req) => !req.headers.has("authorization"))).toBe(true);
  });

  it("redacts a newly created URL from management response debug logs", async () => {
    const logs: ApiLogEntry[] = [];
    setApiLogSink({ record: (entry) => logs.push(entry) });
    await run(["create", "request-1", ...common]);
    expect(JSON.stringify(logs)).not.toContain(token);
    expect(JSON.stringify(logs)).not.toContain("idp-token");
    expect(output[0]).toContain(token);
  });
});
