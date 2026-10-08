// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import type { AccountInfo } from "@azure/msal-browser";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  enabled: true,
  account: null as AccountInfo | null,
  result: null as { account: AccountInfo } | null,
  initialize: vi.fn(),
  handleRedirectPromise: vi.fn(),
  acquireTokenSilent: vi.fn(),
  logoutRedirect: vi.fn(),
  clearCache: vi.fn(),
}));

vi.mock("./authConfig", () => ({
  get isAuthEnabled() { return fake.enabled; },
  authConfig: { isConfigured: true },
  apiTokenRequestScopes: ["scope-api"],
  loginRequestScopes: ["openid", "scope-api"],
  buildMsalConfiguration: () => ({}),
}));

vi.mock("@azure/msal-browser", async (importOriginal) => ({
  ...await importOriginal<typeof import("@azure/msal-browser")>(),
  PublicClientApplication: class {
    initialize = fake.initialize;
    handleRedirectPromise = fake.handleRedirectPromise;
    getActiveAccount = () => fake.account;
    getAllAccounts = () => fake.account ? [fake.account] : [];
    setActiveAccount = (account: AccountInfo) => { fake.account = account; };
    acquireTokenSilent = fake.acquireTokenSilent;
    logoutRedirect = fake.logoutRedirect;
    clearCache = fake.clearCache;
  },
}));

const account: AccountInfo = {
  homeAccountId: "home", localAccountId: "subject", tenantId: "tenant",
  environment: "login.example.test", username: "alice@example.test",
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  fake.enabled = true;
  fake.account = null;
  fake.result = null;
  fake.handleRedirectPromise.mockImplementation(async () => fake.result);
  fake.acquireTokenSilent.mockResolvedValue({ account, accessToken: "idp-token" });
});

describe("redirect login outcome", () => {
  it("retains one account-bound result until consumed, despite repeated initialization", async () => {
    fake.result = { account };
    const auth = await import("./msalInstance");
    await Promise.all([auth.initializeAuth(), auth.initializeAuth()]);
    const event = auth.getPendingRedirectLogin(account);
    expect(event).toEqual({ accountKey: auth.getAccountKey(account) });
    expect(fake.account).toBe(account);
    expect(fake.handleRedirectPromise).toHaveBeenCalledTimes(1);
    expect(auth.getPendingRedirectLogin({ ...account, tenantId: "other-tenant" })).toBeUndefined();
    expect(auth.getPendingRedirectLogin({ ...account, localAccountId: "other-subject" })).toBeUndefined();

    await auth.initializeAuth();
    expect(auth.getPendingRedirectLogin(account)).toBe(event);
    auth.consumeRedirectLogin({ accountKey: event!.accountKey });
    expect(auth.getPendingRedirectLogin(account)).toBe(event);
    auth.consumeRedirectLogin(event!);
    await auth.initializeAuth();
    expect(auth.getPendingRedirectLogin(account)).toBeUndefined();
  });

  it("does not mark a restored account or silent/forced token refresh as a login", async () => {
    fake.account = account;
    const auth = await import("./msalInstance");
    await auth.initializeAuth();
    expect(auth.getPendingRedirectLogin(account)).toBeUndefined();
    expect(await auth.acquireApiToken()).toBe("idp-token");
    expect(await auth.acquireApiToken({ forceRefresh: true })).toBe("idp-token");
    expect(auth.getPendingRedirectLogin(account)).toBeUndefined();
    expect(fake.acquireTokenSilent).toHaveBeenLastCalledWith({
      account, scopes: ["scope-api"], forceRefresh: true,
    });
  });

  it("discards an abandoned callback for logout or account changes", async () => {
    fake.result = { account };
    const auth = await import("./msalInstance");
    await auth.initializeAuth();
    auth.discardRedirectLogin("different-account");
    expect(auth.getPendingRedirectLogin(account)).toBeDefined();
    auth.discardRedirectLogin(auth.getAccountKey(account));
    expect(auth.getPendingRedirectLogin(account)).toBeUndefined();

    vi.resetModules();
    const next = await import("./msalInstance");
    await next.initializeAuth();
    expect(next.getPendingRedirectLogin(account)).toBeDefined();
    await next.logout();
    expect(next.getPendingRedirectLogin(account)).toBeUndefined();
    expect(fake.logoutRedirect).toHaveBeenCalledWith({ account });
  });

  it("does not initialize MSAL when auth is disabled", async () => {
    fake.enabled = false;
    const auth = await import("./msalInstance");
    await auth.initializeAuth();
    expect(fake.initialize).not.toHaveBeenCalled();
    expect(fake.handleRedirectPromise).not.toHaveBeenCalled();
  });
});
