// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { apiClient } from "./api-client";

vi.mock("./api-client", () => ({ apiClient: vi.fn() }));

beforeEach(() => vi.resetAllMocks());

describe("Platform administrator API contract", () => {
  it("fetches a validated uncached page independently of project selection", async () => {
    const page = { items: [{ id: "admin", role: "admin", revision: 1, disabled: false, pending: false }], nextCursor: "admin" };
    vi.mocked(apiClient).mockResolvedValue(Response.json(page));
    const controller = new AbortController();
    expect(await api.listPlatformAdmins({ cursor: "previous/admin", signal: controller.signal })).toEqual(page);
    expect(apiClient).toHaveBeenCalledWith("/api/v1/admin/platform-admins?cursor=previous/admin", {
      signal: controller.signal, cache: "no-store", headers: expect.any(Headers),
    });
  });

  it.each([
    { items: [{ id: "ordinary", role: "user", revision: 0, disabled: false, pending: false }] },
    { items: [{ id: "admin", role: "admin", revision: 1, disabled: false }] },
    { items: "invalid" },
  ])("rejects malformed administrator responses rather than showing an empty success: %j", async page => {
    vi.mocked(apiClient).mockResolvedValue(Response.json(page));
    await expect(api.listPlatformAdmins()).rejects.toThrow();
  });

  it("surfaces authority errors without silently substituting an empty roster", async () => {
    vi.mocked(apiClient).mockResolvedValue(Response.json({ error: "Authority unavailable" }, { status: 503 }));
    await expect(api.listPlatformAdmins()).rejects.toMatchObject({ status: 503, message: "Authority unavailable" });
  });
});
