// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, vi } from "vitest";
import { registerRedirect, verifyMetadata, workspaceName } from "./spike.js";
import { DEFAULT_TENANT } from "./config.js";

describe("spike resource isolation", () => {
  it("scopes names deterministically to each workspace", () => {
    expect(workspaceName("/workspaces/first")).toMatch(/^scope-spike-[a-f\d]{12}$/);
    expect(workspaceName("/workspaces/first")).not.toBe(workspaceName("/workspaces/second"));
    expect(workspaceName("/workspaces/first")).toBe(workspaceName("/workspaces/first"));
  });
});

describe("exact redirect bootstrap", () => {
  const pause = vi.fn(async () => {});
  it.each([201, 409])("accepts idempotent HTTP %s", async (status) => {
    const send = vi.fn(async () => ({ status, body: {} }));
    await registerRedirect(send, pause);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it.each([400, 401, 403, 404])("does not retry HTTP %s", async (status) => {
    const send = vi.fn(async () => ({ status, body: {} }));
    await expect(registerRedirect(send, pause)).rejects.toThrow(`HTTP ${status}`);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("retries network and transient failures with bounded backoff", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValueOnce({ status: 503 }).mockResolvedValue({ status: 201 });
    const pause = vi.fn(async () => {});
    await registerRedirect(send, pause);
    expect(send).toHaveBeenCalledTimes(3);
    expect(pause.mock.calls).toEqual([[500], [1000]]);
  });
  it("fails closed after five attempts", async () => {
    const send = vi.fn(async () => ({ status: 503, body: {} }));
    await expect(registerRedirect(send, pause)).rejects.toThrow(/five attempts/);
    expect(send).toHaveBeenCalledTimes(5);
  });
});

describe("actual-image metadata acceptance", () => {
  const origin = "https://example.app.github.dev";
  const issuer = `${origin}/${DEFAULT_TENANT}/v2.0`;
  const discovery = {
    issuer,
    authorization_endpoint: `${origin}/${DEFAULT_TENANT}/oauth2/v2.0/authorize`,
    token_endpoint: `${origin}/${DEFAULT_TENANT}/oauth2/v2.0/token`,
    jwks_uri: `${origin}/${DEFAULT_TENANT}/discovery/v2.0/keys`,
    end_session_endpoint: `${origin}/${DEFAULT_TENANT}/oauth2/v2.0/logout`,
    userinfo_endpoint: `${origin}/graph/oidc/userinfo`,
  };
  it("accepts matching discovery and key issuers", () => {
    expect(() => verifyMetadata(discovery, { keys: [{ issuer }] }, origin, DEFAULT_TENANT)).not.toThrow();
  });
  it("rejects an internal hostname advertised to the browser", () => {
    expect(() => verifyMetadata({ ...discovery, token_endpoint: "https://entra-local:8443/token" }, { keys: [{ issuer }] }, origin, DEFAULT_TENANT)).toThrow(/endpoint/);
  });
  it.each([{ keys: [] }, { keys: [{ issuer: "https://wrong.example.org" }] }, { keys: [{}] }])("requires the external issuer on every JWK", (jwks) => {
    expect(() => verifyMetadata(discovery, jwks, origin, DEFAULT_TENANT)).toThrow(/JWK/);
  });
  it("rejects the wrong discovery issuer", () => {
    expect(() => verifyMetadata({ ...discovery, issuer: "https://wrong.example.org" }, { keys: [{ issuer }] }, origin, DEFAULT_TENANT)).toThrow(/issuer/);
  });
});