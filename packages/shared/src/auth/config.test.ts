// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { loadAuthConfigFromEnv } from "./config.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const SUBJECT = "aaaaaaaa-0000-0000-0000-000000000001";
const API_CLIENT_ID = "cccccccc-0000-0000-0000-000000000005";

function baseEnv(): NodeJS.ProcessEnv {
  return {
    AUTH_PROVIDER: "entra",
    AUTH_AUTHORITY: `https://localhost:8443/${TENANT}`,
    AUTH_API_CLIENT_ID: API_CLIENT_ID,
  };
}

describe("loadAuthConfigFromEnv", () => {
  it("fails closed when auth is enabled by default without IdP configuration", () => {
    expect(() => loadAuthConfigFromEnv({})).toThrow(/AUTH_PROVIDER, AUTH_AUTHORITY, AUTH_API_CLIENT_ID/);
  });

  it.each(["false", "0", "no", "off", " FALSE "])("explicitly disables auth and ignores unused IdP settings with %j", value => {
    expect(loadAuthConfigFromEnv({ SCOPE_AUTH_ENABLED: value })).toBeNull();
    expect(loadAuthConfigFromEnv({
      SCOPE_AUTH_ENABLED: value, AUTH_PROVIDER: "unused", AUTH_USER_CACHE_TTL_SECONDS: "unused",
    })).toBeNull();
  });

  it.each(["", "typo", "true", "1", "on", "yes"])("does not let %j bypass missing IdP configuration", value => {
    expect(() => loadAuthConfigFromEnv({ SCOPE_AUTH_ENABLED: value })).toThrow(/Incomplete authentication configuration/);
  });

  it("throws when any required variable is missing", () => {
    const { AUTH_API_CLIENT_ID: _omitted, ...partial } = baseEnv();
    void _omitted;
    expect(() => loadAuthConfigFromEnv(partial)).toThrow(
      /Incomplete authentication configuration: missing AUTH_API_CLIENT_ID/,
    );
  });

  it("throws when optional auth settings are present without required settings", () => {
    expect(() =>
      loadAuthConfigFromEnv({ AUTH_SCOPES: "api://scope/access" }),
    ).toThrow(/AUTH_PROVIDER, AUTH_AUTHORITY, AUTH_API_CLIENT_ID/);
  });

  it("throws on an unsupported provider", () => {
    expect(() =>
      loadAuthConfigFromEnv({ ...baseEnv(), AUTH_PROVIDER: "okta" }),
    ).toThrow(/Unsupported AUTH_PROVIDER/);
  });

  it("builds an entra runtime from the required variables", () => {
    const runtime = loadAuthConfigFromEnv(baseEnv());
    expect(runtime).not.toBeNull();
    expect(runtime?.provider.id).toBe("entra");
    expect(runtime?.enricher).toBeDefined();
    expect(runtime?.userCacheTtlSeconds).toBe(300);
  });

  it.each(["1", "60", "300", "9007199254740991"])("accepts a positive safe cache TTL of %s", (ttl) => {
    expect(loadAuthConfigFromEnv({
      ...baseEnv(),
      AUTH_USER_CACHE_TTL_SECONDS: ttl,
    })?.userCacheTtlSeconds).toBe(Number(ttl));
  });

  it.each([
    "", " ", " 300", "300 ", "0", "-1", "0.5", "1.0", "1e3", "+5",
    "0x10", "NaN", "Infinity", "abc", "300seconds", "9007199254740992",
  ])("rejects an invalid cache TTL of %j", (ttl) => {
    expect(() => loadAuthConfigFromEnv({
      ...baseEnv(),
      AUTH_USER_CACHE_TTL_SECONDS: ttl,
    })).toThrow(/AUTH_USER_CACHE_TTL_SECONDS must be a positive safe integer/);
  });

  it("requires explicit opt-out even when only a valid cache TTL is set", () => {
    expect(() => loadAuthConfigFromEnv({ AUTH_USER_CACHE_TTL_SECONDS: "60" })).toThrow(/Incomplete authentication configuration/);
  });

  it("validates a supplied cache TTL when authentication defaults to enabled", () => {
    expect(() => loadAuthConfigFromEnv({ AUTH_USER_CACHE_TTL_SECONDS: "0" }))
      .toThrow(/AUTH_USER_CACHE_TTL_SECONDS/);
  });

  it("does not let a cache TTL bypass incomplete IdP configuration", () => {
    expect(() => loadAuthConfigFromEnv({
      AUTH_USER_CACHE_TTL_SECONDS: "60",
      AUTH_PROVIDER: "entra",
    })).toThrow(/AUTH_AUTHORITY, AUTH_API_CLIENT_ID/);
  });

  it("accepts the entra-local issuer/JWKS overrides without error", () => {
    const runtime = loadAuthConfigFromEnv({
      ...baseEnv(),
      AUTH_ISSUER_TEMPLATE: "https://localhost:8443/{tenantid}/v2.0",
      AUTH_JWKS_URI: `https://localhost:8443/${TENANT}/discovery/v2.0/keys`,
    });
    expect(runtime?.provider.id).toBe("entra");
  });

  it.each(["AUTH_BOOTSTRAP_ADMINS", "AUTH_BOOTSTRAP_TENANTS"])("rejects retired %s rather than silently suggesting login can grant admin", key => {
    expect(() => loadAuthConfigFromEnv({ ...baseEnv(), [key]: `entra:${TENANT}/${SUBJECT}` }))
      .toThrow(/retired.*operator bootstrap-admin/);
  });
  it("accepts cleared retired settings without granting any bootstrap behavior", () => {
    expect(loadAuthConfigFromEnv({ ...baseEnv(), AUTH_BOOTSTRAP_ADMINS: "", AUTH_BOOTSTRAP_TENANTS: " " })?.provider.id).toBe("entra");
  });
});
