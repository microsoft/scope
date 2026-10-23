// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, describe, expect, it, vi } from "vitest";
import { serviceAuthHeaders } from "./service-auth.js";
import { upsertAgent } from "./upsert-agent.js";

describe("serviceAuthHeaders", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("returns no headers when no key is configured", () => {
    expect(serviceAuthHeaders({})).toEqual({});
    expect(serviceAuthHeaders({ SCOPE_INTERNAL_API_KEY: "" })).toEqual({});
  });

  it("identifies the model-scanner principal when a key is configured", () => {
    expect(serviceAuthHeaders({ SCOPE_INTERNAL_API_KEY: "secret" })).toEqual({
      "X-Service-Name": "model-scanner",
      "X-Internal-Key": "secret",
    });
  });

  it("is sent on API writes", async () => {
    vi.stubEnv("SCOPE_INTERNAL_API_KEY", "secret");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await upsertAgent("http://api", { _id: "a" } as never);

    expect(fetchMock.mock.calls[0][1].headers).toEqual({
      "Content-Type": "application/json",
      "X-Service-Name": "model-scanner",
      "X-Internal-Key": "secret",
    });
  });
});
