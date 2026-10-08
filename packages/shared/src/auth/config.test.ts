// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { bootstrapAdminKey, loadAuthConfigFromEnv } from "./config.js";

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
  it("returns null when AUTH_* is not configured", () => {
    expect(loadAuthConfigFromEnv({})).toBeNull();
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
    expect(runtime?.bootstrapAdmins.size).toBe(0);
    expect(runtime?.bootstrapTenants.size).toBe(0);
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

  it("does not enable IdP configuration when only a valid cache TTL is set", () => {
    expect(loadAuthConfigFromEnv({ AUTH_USER_CACHE_TTL_SECONDS: "60" })).toBeNull();
  });

  it("validates a supplied cache TTL even with authentication disabled", () => {
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

  it("parses bootstrap admins and tenants as trimmed, non-empty sets", () => {
    const runtime = loadAuthConfigFromEnv({
      ...baseEnv(),
      AUTH_BOOTSTRAP_ADMINS: ` entra:${TENANT}/${SUBJECT} , , entra:${TENANT}/other `,
      AUTH_BOOTSTRAP_TENANTS: `${TENANT}, `,
    });
    expect(runtime?.bootstrapAdmins).toEqual(
      new Set([
        bootstrapAdminKey("entra", TENANT, SUBJECT),
        `entra:${TENANT}/other`,
      ]),
    );
    expect(runtime?.bootstrapTenants).toEqual(new Set([TENANT]));
  });

  it("requires a tenant allowlist when bootstrap admins are configured", () => {
    expect(() =>
      loadAuthConfigFromEnv({
        ...baseEnv(),
        AUTH_BOOTSTRAP_ADMINS: `entra:${TENANT}/${SUBJECT}`,
      }),
    ).toThrow(/AUTH_BOOTSTRAP_TENANTS is required/);
  });
});

describe("bootstrapAdminKey", () => {
  it("formats the identity triple as `${idp}:${tenant}/${subject}`", () => {
    expect(bootstrapAdminKey("entra", TENANT, SUBJECT)).toBe(
      `entra:${TENANT}/${SUBJECT}`,
    );
  });
});
