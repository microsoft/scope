// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { apiClient } from "./api-client";

vi.mock("./api-client", () => ({ apiClient: vi.fn() }));

beforeEach(() => vi.resetAllMocks());

describe("Project membership candidate search API contract", () => {
  it("uses the explicit encoded project with query/cursor, cancellation and no-store", async () => {
    const page = { items: [{ id: "candidate", role: "user", revision: 0, disabled: false }], nextCursor: "candidate" };
    vi.mocked(apiClient).mockResolvedValue(Response.json(page));
    const controller = new AbortController();
    expect(await api.searchProjectMembers("project/a", {
      q: "Alice + Example", cursor: "previous/user", signal: controller.signal,
    })).toEqual(page);
    expect(apiClient).toHaveBeenCalledWith(
      "/api/v1/projects/project%2Fa/members/search?q=Alice%20%2B%20Example&cursor=previous/user",
      { signal: controller.signal, cache: "no-store", headers: expect.any(Headers) },
    );
  });

  it("rejects malformed search pages instead of showing an empty success", async () => {
    vi.mocked(apiClient).mockResolvedValue(Response.json({ items: [{ id: "candidate" }] }));
    await expect(api.searchProjectMembers("project")).rejects.toThrow();
  });

  it.each([403, 404, 503])("surfaces search authority/availability errors (%s)", async status => {
    vi.mocked(apiClient).mockResolvedValue(Response.json({ error: "Search unavailable" }, { status }));
    await expect(api.searchProjectMembers("project")).rejects.toMatchObject({ status, message: "Search unavailable" });
    expect(apiClient).toHaveBeenCalledOnce();
  });
});
