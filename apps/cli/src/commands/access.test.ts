// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Command } from "commander";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAccessCommands } from "./access.js";
import { resetApiClient } from "../utils/api-client.js";

describe("access CLI operations", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  let originalExitCode: typeof process.exitCode;
  let payload: unknown;

  afterAll(() => { output.mockRestore(); errors.mockRestore(); });
  beforeEach(() => {
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    resetApiClient();
    vi.stubEnv("SCOPE_TOKEN", "fixture-raw-idp-bearer");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    payload = undefined;
    output.mockClear();
    errors.mockClear();
  });
  afterEach(() => {
    resetApiClient();
    process.exitCode = originalExitCode;
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  async function run(...args: string[]) {
    const program = new Command().exitOverride();
    registerAccessCommands(program);
    await program.parseAsync(["access", ...args, "--url", "http://localhost:3101"], { from: "user" });
  }
  function respond(status: number, body: unknown) {
    fetchMock.mockImplementationOnce(async input => {
      if (!(input instanceof Request)) throw new Error("Expected Request");
      payload = input.body ? await input.clone().json() : undefined;
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    });
  }
  function request(): Request {
    const input = fetchMock.mock.calls[0][0];
    if (!(input instanceof Request)) throw new Error("CLI transport must send a Request");
    return input;
  }

  it.each(["operation", "reconcile"])("does not expose the retired %s command or issue an HTTP request", async name => {
    await expect(run(name, "fixture-operation")).rejects.toMatchObject({ code: "commander.unknownCommand" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards the unchanged raw bearer and explicit idempotency key with the expected revision", async () => {
    respond(200, { operationId: "reviewed-assignment", state: "completed", revision: 5 });
    await run("set-member", "project", "user", "--role", "reader", "--revision", "4", "--operation-id", "reviewed-assignment");
    expect(request().headers.get("Authorization")).toBe("Bearer fixture-raw-idp-bearer");
    expect(request().headers.get("Idempotency-Key")).toBe("reviewed-assignment");
    expect(request().method).toBe("PUT");
    expect(payload).toEqual({ role: "reader", revision: 4 });
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("reviewed-assignment"));
    expect(process.exitCode).toBeUndefined();
  });

  it("prints a generated operation key before sending the mutation", async () => {
    fetchMock.mockImplementationOnce(async input => {
      if (!(input instanceof Request)) throw new Error("Expected Request");
      const key = input.headers.get("Idempotency-Key");
      if (!key) throw new Error("Missing idempotency key");
      expect(key).toMatch(/^[0-9a-f-]{36}$/);
      expect(errors).toHaveBeenCalledWith(expect.stringContaining(key));
      return Response.json({ operationId: key, state: "completed", revision: 1 });
    });
    await run("disable-user", "user", "--revision", "0");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("reports an uncertain 202 without claiming completion or retrying it", async () => {
    respond(202, { operationId: "uncertain", state: "pending", revision: 1 });
    await run("revoke-member", "project", "user", "--revision", "0", "--operation-id", "uncertain");
    expect(process.exitCode).toBe(2);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("No completion claimed"));
    expect(output).toHaveBeenCalledWith(expect.stringContaining('"state": "pending"'));
  });

  it("surfaces conflicts without retrying or logging successful output", async () => {
    respond(409, { error: "idempotency_conflict" });
    await run("set-member", "project", "user", "--role", "admin", "--revision", "0", "--operation-id", "reused");
    expect(process.exitCode).toBe(1);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("HTTP 409"));
    expect(output).not.toHaveBeenCalled();
  });

  it("rejects invalid revisions before sending any request", async () => {
    await run("disable-user", "user", "--revision", "-1");
    expect(process.exitCode).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads own account using GET and never implicitly enrolls", async () => {
    respond(200, { id: "fixture" });
    await run("me");
    expect(request().method).toBe("GET");
    expect(request().headers.has("Idempotency-Key")).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("looks up only the exact enrolled member UUID within the explicit project", async () => {
    respond(200, { id: "target" });
    await run("find-member", "project/a", "target/uuid");
    expect(new URL(request().url).pathname).toBe("/api/v1/projects/project%2Fa/members/lookup/target%2Fuuid");
    expect(request().method).toBe("GET");
    expect(request().headers.get("Authorization")).toBe("Bearer fixture-raw-idp-bearer");
    expect(request().headers.has("Idempotency-Key")).toBe(false);
  });
  it.each([403, 404])("surfaces a denied or foreign project roster (%s) without enrollment or retry", async status => {
    respond(status, { error: "not_permitted" });
    await run("members", "foreign-project");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
    expect(output).not.toHaveBeenCalled();
  });

  it("searches the platform-only enrolled-user directory with paging and the raw bearer", async () => {
    respond(200, { items: [], nextCursor: "next-user" });
    await run("search-users", "Bob + Example", "--limit", "5", "--cursor", "previous-user");
    const url = new URL(request().url);
    expect(url.pathname).toBe("/api/v1/admin/users/search");
    expect(url.searchParams.get("q")).toBe("Bob + Example");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(url.searchParams.get("cursor")).toBe("previous-user");
    expect(request().method).toBe("GET");
    expect(request().headers.get("Authorization")).toBe("Bearer fixture-raw-idp-bearer");
  });

  it("searches enrolled membership candidates through an explicit project with paging and the raw bearer", async () => {
    respond(200, { items: [], nextCursor: "next-user" });
    await run("search-members", "project/a", "Alice + Example", "--limit", "5", "--cursor", "previous-user");
    const url = new URL(request().url);
    expect(url.pathname).toBe("/api/v1/projects/project%2Fa/members/search");
    expect(url.searchParams.get("q")).toBe("Alice + Example");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(url.searchParams.get("cursor")).toBe("previous-user");
    expect(request().method).toBe("GET");
    expect(request().headers.get("Authorization")).toBe("Bearer fixture-raw-idp-bearer");
    expect(request().headers.has("Idempotency-Key")).toBe(false);
  });

  it.each([403, 404])("reports a denied project member search (%s) without using the admin directory", async status => {
    respond(status, { error: "not_permitted" });
    await run("search-members", "project", "alice");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(new URL(request().url).pathname).toBe("/api/v1/projects/project/members/search");
    expect(process.exitCode).toBe(1);
    expect(output).not.toHaveBeenCalled();
  });

  it("rejects an invalid directory page size before sending a request", async () => {
    await run("search-users", "--limit", "51");
    await run("search-members", "project", "--limit", "0");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("lists only platform administrators using server-side cursor pagination", async () => {
    respond(200, { items: [], nextCursor: "next-admin" });
    await run("platform-admins", "--limit", "5", "--cursor", "previous-admin");
    const url = new URL(request().url);
    expect(url.pathname).toBe("/api/v1/admin/platform-admins");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(url.searchParams.get("cursor")).toBe("previous-admin");
    expect(request().method).toBe("GET");
    expect(request().headers.has("Idempotency-Key")).toBe(false);
  });

  it("promotes an exact enrolled Scope user with revision and stable operation ID, not arbitrary role input", async () => {
    respond(200, { operationId: "approved-promotion", state: "completed", revision: 5 });
    await run("promote-admin", "scope/user", "--revision", "4", "--operation-id", "approved-promotion");
    expect(new URL(request().url).pathname).toBe("/api/v1/admin/users/scope%2Fuser/promote");
    expect(request().method).toBe("POST");
    expect(request().headers.get("Idempotency-Key")).toBe("approved-promotion");
    expect(payload).toEqual({ revision: 4 });
    expect(process.exitCode).toBeUndefined();
  });

  it("preserves a pending administrator promotion instead of retrying with a new operation", async () => {
    respond(202, { operationId: "pending-promotion", state: "pending", revision: 1 });
    await run("promote-admin", "user", "--revision", "0", "--operation-id", "pending-promotion");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(2);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("No completion claimed"));
  });

  it("rejects invalid administrator revisions and page sizes locally", async () => {
    await run("promote-admin", "user", "--revision", "1.5");
    await run("platform-admins", "--limit", "0");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
