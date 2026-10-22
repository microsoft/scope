// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";
import { apiClient } from "./api-client";

vi.mock("./api-client", () => ({ apiClient: vi.fn() }));

const user = { id: "11111111-2222-4333-8444-555555555555", role: "user",
  capabilities: { platformAdmin: false, reportsEnabled: false, memberships: [] } };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(apiClient).mockResolvedValue(new Response(JSON.stringify(user)));
});

describe("current user API", () => {
  it.each([
    ["getCurrentUser", "GET"],
    ["enrollCurrentUser", "POST"],
  ] as const)("sends %s as an uncached %s request with caller cancellation", async (operation, method) => {
    const controller = new AbortController();
    expect(await api[operation]({ signal: controller.signal })).toEqual(user);
    expect(apiClient).toHaveBeenCalledWith("/api/v1/users/me", {
      method,
      headers: expect.any(Headers),
      cache: "no-store",
      signal: controller.signal,
    });
    const headers = vi.mocked(apiClient).mock.calls[0][1]?.headers;
    if (!(headers instanceof Headers)) throw new Error("Expected Headers");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it.each([
    undefined,
    { platformAdmin: true, reportsEnabled: true, memberships: [] },
    { platformAdmin: "true", reportsEnabled: false, memberships: [] },
    { platformAdmin: false, reportsEnabled: false, memberships: [
      { projectId: "p", role: "reader", permissions: ["content:read", "content:write"], revision: 1 },
    ] },
    { platformAdmin: false, reportsEnabled: false, memberships: [
      { projectId: "p", role: "owner", permissions: ["*"], revision: 1 },
    ] },
  ])("fails closed on missing or malformed capabilities: %j", async capabilities => {
    vi.mocked(apiClient).mockResolvedValue(new Response(JSON.stringify({ ...user, capabilities })));
    await expect(api.getCurrentUser()).rejects.toThrow("Invalid access capabilities");
  });

  it("keeps HTTP status and code without changing existing error messages", async () => {
    vi.mocked(apiClient).mockResolvedValue(new Response(JSON.stringify({
      error: "Not enrolled", code: "user_not_enrolled",
    }), { status: 403 }));
    await expect(api.getCurrentUser()).rejects.toMatchObject({
      name: "ApiError", message: "Not enrolled", status: 403, code: "user_not_enrolled",
    });
  });

  it("preserves existing validation detail formatting", async () => {
    vi.mocked(apiClient).mockResolvedValue(new Response(JSON.stringify({
      error: "Invalid request", details: [{ path: "login", message: "Invalid value" }],
    }), { status: 400 }));
    await expect(api.getCurrentUser()).rejects.toEqual(
      new ApiError("Invalid request: login: Invalid value", 400),
    );
  });

  it("retains HTTP fallback messages for non-JSON errors", async () => {
    vi.mocked(apiClient).mockResolvedValue(new Response("", { status: 503 }));
    await expect(api.getCurrentUser()).rejects.toMatchObject({
      message: "HTTP 503", status: 503,
    });
  });
});
