// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, describe, expect, it, vi } from "vitest";
import { RestApiCriteriaProvider } from "./criteria-provider-api.js";
import { createCriteriaProvider } from "./criteria-provider-factory.js";

const criterion = { id: "c1", name: "C1", description: "d", dependsOn: [] };

function stubFetch() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => [criterion],
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("RestApiCriteriaProvider bearer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("sends no Authorization header without a bearer", async () => {
    const fetchMock = stubFetch();
    await new RestApiCriteriaProvider("http://api/", { projectId: "p1" }).getAll();
    expect(fetchMock).toHaveBeenCalledWith("http://api/api/v1/criteria?projectId=p1");
  });

  it("sends the run token as a bearer when provided", async () => {
    const fetchMock = stubFetch();
    await new RestApiCriteriaProvider("http://api", { bearer: () => "scope_rt_x" }).getAll();
    expect(fetchMock).toHaveBeenCalledWith("http://api/api/v1/criteria", {
      headers: { Authorization: "Bearer scope_rt_x" },
    });
  });

  it("createCriteriaProvider wires the bearer into the REST provider", async () => {
    vi.stubEnv("CRITERIA_API_URL", "http://api");
    const fetchMock = stubFetch();
    await createCriteriaProvider("p1", { bearer: () => "scope_rt_y" }).getAll();
    expect(fetchMock).toHaveBeenCalledWith("http://api/api/v1/criteria?projectId=p1", {
      headers: { Authorization: "Bearer scope_rt_y" },
    });
  });
});
