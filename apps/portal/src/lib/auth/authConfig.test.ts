// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAuthEnabled } from "./authConfig";

// The auth feature is ON by default (secure by default) with three independent
// per-environment controls:
//  - local dev      -> VITE_AUTH_ENABLED_LOCAL (build-time)
//  - integration    -> SCOPE_AUTH_ENABLED (runtime, __SCOPE_CONFIG__.authEnabled)
//  - production      -> SCOPE_AUTH_ENABLED (runtime, __SCOPE_CONFIG__.authEnabled)
// Resolution: runtime (int/prod) wins; else local vite flag (dev); else default.
function env(overrides: Record<string, string | undefined>): ImportMetaEnv {
  return overrides as unknown as ImportMetaEnv;
}
function runtime(
  overrides: Partial<ScopeRuntimeConfig> | undefined,
): ScopeRuntimeConfig | undefined {
  return overrides as ScopeRuntimeConfig | undefined;
}

describe("resolveAuthEnabled", () => {
  it("is enabled by default (no runtime config, no local flag) everywhere", () => {
    expect(resolveAuthEnabled(undefined, env({}), true)).toBe(true);
    expect(resolveAuthEnabled(undefined, env({}), false)).toBe(true);
  });

  describe("build-time authentication settings", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      vi.resetModules();
    });

    async function config(overrides: Record<string, string> = {}) {
      vi.resetModules();
      vi.stubGlobal("window", { location: { origin: "https://scope.example.com" } });
      vi.stubEnv("DEV", false);
      for (const [key, value] of Object.entries({
        VITE_AUTH_CLIENT_ID: "portal-client",
        VITE_AUTH_AUTHORITY: "https://login.microsoftonline.com/test-tenant",
        VITE_AUTH_KNOWN_AUTHORITIES: "",
        VITE_AUTH_SCOPES: "api://api-client/access_as_user",
        VITE_AUTH_PROTOCOL_MODE: "",
        VITE_AUTH_REDIRECT_URI: "",
        VITE_AUTH_POST_LOGOUT_REDIRECT_URI: "",
        VITE_AUTH_CACHE_LOCATION: "",
        ...overrides,
      })) {
        vi.stubEnv(key, value);
      }
      return (await import("./authConfig")).authConfig;
    }

    it("preserves production defaults when optional Docker build args are empty", async () => {
      expect(await config()).toMatchObject({
        clientId: "portal-client",
        authority: "https://login.microsoftonline.com/test-tenant",
        scopes: ["api://api-client/access_as_user"],
        knownAuthorities: [],
        protocolMode: "AAD",
        redirectUri: "https://scope.example.com",
        postLogoutRedirectUri: "https://scope.example.com",
        cacheLocation: "localStorage",
        enabled: true,
        isConfigured: true,
      });
    });

    it("uses explicit optional build settings", async () => {
      expect(await config({
        VITE_AUTH_KNOWN_AUTHORITIES: "login.example.com, other.example.com",
        VITE_AUTH_SCOPES: "api://api-client/read, api://api-client/write",
        VITE_AUTH_PROTOCOL_MODE: "OIDC",
        VITE_AUTH_REDIRECT_URI: "https://scope.example.com/callback",
        VITE_AUTH_POST_LOGOUT_REDIRECT_URI: "https://scope.example.com/signed-out",
        VITE_AUTH_CACHE_LOCATION: "sessionStorage",
      })).toMatchObject({
        knownAuthorities: ["login.example.com", "other.example.com"],
        scopes: ["api://api-client/read", "api://api-client/write"],
        protocolMode: "OIDC",
        redirectUri: "https://scope.example.com/callback",
        postLogoutRedirectUri: "https://scope.example.com/signed-out",
        cacheLocation: "sessionStorage",
      });
    });

    it.each(["VITE_AUTH_CLIENT_ID", "VITE_AUTH_AUTHORITY"])(
      "does not silently use the emulator when production %s is missing",
      async (key) => {
        expect((await config({ [key]: "" })).isConfigured).toBe(false);
      },
    );
  });

  it("runtime authEnabled governs integration/production (built bundle)", () => {
    expect(
      resolveAuthEnabled(runtime({ authEnabled: false }), env({}), false),
    ).toBe(false);
    expect(
      resolveAuthEnabled(runtime({ authEnabled: true }), env({}), false),
    ).toBe(true);
  });

  it("runtime authEnabled wins over the local vite flag even in dev", () => {
    expect(
      resolveAuthEnabled(
        runtime({ authEnabled: false }),
        env({ VITE_AUTH_ENABLED_LOCAL: "true" }),
        true,
      ),
    ).toBe(false);
  });

  it("local VITE_AUTH_ENABLED_LOCAL controls local dev only", () => {
    expect(
      resolveAuthEnabled(undefined, env({ VITE_AUTH_ENABLED_LOCAL: "false" }), true),
    ).toBe(false);
    // Built bundle ignores the local flag; with no runtime config it falls back
    // to the secure default.
    expect(
      resolveAuthEnabled(undefined, env({ VITE_AUTH_ENABLED_LOCAL: "false" }), false),
    ).toBe(true);
  });

  it("accepts a string runtime value and common spellings", () => {
    for (const v of ["false", "0", "no", "off", "FALSE", " false "]) {
      expect(
        resolveAuthEnabled(runtime({ authEnabled: v as never }), env({}), false),
      ).toBe(false);
    }
    for (const v of ["true", "1", "yes", "on"]) {
      expect(
        resolveAuthEnabled(runtime({ authEnabled: v as never }), env({}), false),
      ).toBe(true);
    }
  });

  it("local flag fails safe to enabled on a nonsense value", () => {
    expect(
      resolveAuthEnabled(undefined, env({ VITE_AUTH_ENABLED_LOCAL: "maybe" }), true),
    ).toBe(true);
  });
});
