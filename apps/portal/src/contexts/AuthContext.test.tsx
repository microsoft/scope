// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, focusManager, useQuery } from "@tanstack/react-query";
import type { AccountInfo } from "@azure/msal-browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth, type AuthContextValue } from "./AuthContext";
import { FeatureFlagProvider } from "./FeatureFlagContext";
import { RequireAuth } from "@/components/auth/RequireAuth";
import { useFavicon } from "@/hooks/useFavicon";
import { api } from "@/lib/api";
import {
  resetApiClient, setApiTokenProvider, setReauthHandler,
  type TokenProvider, type ReauthHandler,
} from "@/lib/api-client";
import { getAccountKey } from "@/lib/auth/msalInstance";

const msal = vi.hoisted(() => ({
  account: null as AccountInfo | null,
  inProgress: "none",
  enabled: true,
  pending: undefined as { accountKey: string } | undefined,
  login: vi.fn(),
  logout: vi.fn(),
  consume: vi.fn(),
  discard: vi.fn(),
}));

vi.mock("@azure/msal-react", () => ({
  useAccount: () => msal.account,
  useMsal: () => ({
    instance: { getActiveAccount: () => msal.account },
    accounts: msal.account ? [msal.account] : [],
    inProgress: msal.inProgress,
  }),
}));

vi.mock("@/lib/auth/msalInstance", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/msalInstance")>();
  return {
    ...actual,
    get isAuthEnabled() { return msal.enabled; },
    isAuthConfigured: true,
    login: msal.login,
    logout: msal.logout,
    getPendingRedirectLogin: (account: AccountInfo) =>
      msal.pending?.accountKey === actual.getAccountKey(account) ? msal.pending : undefined,
    consumeRedirectLogin: (event: { accountKey: string }) => {
      msal.consume(event);
      if (msal.pending === event) msal.pending = undefined;
    },
    discardRedirectLogin: (key: string) => {
      msal.discard(key);
      if (msal.pending?.accountKey === key) msal.pending = undefined;
    },
  };
});

const alice: AccountInfo = {
  homeAccountId: "home",
  localAccountId: "alice-subject",
  tenantId: "tenant",
  environment: "login.example.test",
  username: "alice@example.test",
  name: "IdP Alice",
  idTokenClaims: { roles: ["idp-admin"] },
};
const scopeAlice = {
  id: "11111111-2222-4333-8444-555555555555",
  role: "user",
  displayName: "Scope Alice",
  email: "scope-alice@example.test",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function pathOf(request: Request): string {
  const url = new URL(request.url);
  return url.pathname + url.search;
}

let auth: AuthContextValue;
function AuthProbe() {
  auth = useAuth();
  return <output data-testid="auth-status">{auth.status}</output>;
}

function ApplicationQueries() {
  useFavicon();
  useQuery({ queryKey: ["projects"], queryFn: () => api.listProjects() });
  return <div>Application content</div>;
}

describe("Scope authentication handshake", () => {
  let client: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn>;
  let token: ReturnType<typeof vi.fn<TokenProvider>>;
  let reauth: ReturnType<typeof vi.fn<ReauthHandler>>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetApiClient();
    msal.account = alice;
    msal.inProgress = "none";
    msal.enabled = true;
    msal.pending = undefined;
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    fetchMock = vi.fn(async (request: Request) => response(
      pathOf(request).startsWith("/api/v1/users/me") ? scopeAlice : [],
    ));
    vi.stubGlobal("fetch", fetchMock);
    token = vi.fn().mockResolvedValue("idp-access-token");
    reauth = vi.fn();
    setApiTokenProvider(token);
    setReauthHandler(reauth);
  });

  afterEach(async () => {
    cleanup();
    await act(async () => {});
    client.clear();
    focusManager.setFocused(undefined);
    resetApiClient();
    vi.unstubAllGlobals();
  });

  function freshLogin() {
    msal.pending = { accountKey: getAccountKey(alice) };
  }

  function tree() {
    return (
      <StrictMode>
        <QueryClientProvider client={client}>
          <AuthProvider>
            <AuthProbe />
            {/* Keep this eager provider outside the guard to test its own gate. */}
            <FeatureFlagProvider>
              <RequireAuth>
                <ApplicationQueries />
              </RequireAuth>
            </FeatureFlagProvider>
          </AuthProvider>
        </QueryClientProvider>
      </StrictMode>
    );
  }

  function requests() {
    return fetchMock.mock.calls.map(([request]) => pathOf(request));
  }

  function requestMethods() {
    return fetchMock.mock.calls.map(([request]) => (request as Request).method);
  }

  it("sends exactly the enrollment POST first; flags, favicon and pages wait for its response", async () => {
    freshLogin();
    const lookup = deferred<Response>();
    fetchMock.mockImplementationOnce(() => lookup.promise);
    const view = render(tree());

    await waitFor(() => expect(requests()).toEqual(["/api/v1/users/me"]));
    const request = fetchMock.mock.calls[0][0] as Request;
    expect(request.method).toBe("POST");
    expect(request.headers.get("authorization")).toBe("Bearer idp-access-token");
    expect(auth.isReady).toBe(false);
    expect(auth.isAuthenticated).toBe(false);
    expect(auth.user).toBeNull();
    expect(screen.queryByText("Application content")).toBeNull();

    view.rerender(tree());
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    expect(requests()).toEqual(["/api/v1/users/me"]);
    expect(msal.consume).not.toHaveBeenCalled();

    await act(async () => lookup.resolve(response(scopeAlice)));
    await waitFor(() => expect(requests()).toEqual(expect.arrayContaining([
      "/api/v1/feature-flags", "/api/v1/version", "/api/v1/projects",
    ])));
    expect(auth.user).toMatchObject({
      ...scopeAlice, name: "Scope Alice", username: alice.username, subject: alice.localAccountId,
    });
    expect(auth.isAuthenticated).toBe(true);
    expect(auth.isReady).toBe(true);
    expect(msal.consume).toHaveBeenCalledTimes(1);
    expect(msal.pending).toBeUndefined();

    view.rerender(tree());
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    expect(requests().filter((path) => path.includes("/users/me"))).toHaveLength(1);
  });

  it("uses a plain lookup on cached-account reload and keeps IdP display fallbacks", async () => {
    fetchMock.mockResolvedValueOnce(response({ id: scopeAlice.id, role: "admin" }));
    render(tree());
    await waitFor(() => expect(auth.isReady).toBe(true));
    expect(requests()[0]).toBe("/api/v1/users/me");
    expect(requestMethods()[0]).toBe("GET");
    expect(auth.user).toEqual({
      id: scopeAlice.id, role: "admin", name: alice.name,
      username: alice.username, subject: alice.localAccountId,
    });
    expect(msal.consume).not.toHaveBeenCalled();
  });

  it("does not start any Scope queries while signed out or MSAL is still resolving", async () => {
    msal.account = null;
    const view = render(tree());
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(auth.status).toBe("signed-out");
    expect(auth.isReady).toBe(false);
    expect(screen.getByRole("button", { name: "Log in" })).toBeTruthy();

    msal.account = alice;
    msal.inProgress = "handleRedirect";
    view.rerender(tree());
    await act(async () => {});
    expect(auth.status).toBe("resolving");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves anonymous app queries when auth is disabled without fabricating a user", async () => {
    msal.account = null;
    msal.enabled = false;
    render(tree());
    await waitFor(() => expect(requests()).toContain("/api/v1/feature-flags"));
    expect(requests()).toContain("/api/v1/projects");
    expect(requests()).toContain("/api/v1/version");
    expect(requests().some((path) => path.includes("/users/me"))).toBe(false);
    expect(auth.user).toBeNull();
    expect(auth.isReady).toBe(true);
  });

  it("requires explicit login for an unenrolled restored account, never automatically enrolling or redirecting", async () => {
    fetchMock.mockResolvedValueOnce(response({ error: "Not enrolled", code: "user_not_enrolled" }, 403));
    const view = render(tree());
    await screen.findByText("Sign in to join Scope");
    expect(auth.status).toBe("denied");
    expect(auth.error).toMatchObject({ status: 403, code: "user_not_enrolled", message: "Not enrolled" });
    expect(auth.user).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    view.rerender(tree());
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    expect(requests()).toEqual(["/api/v1/users/me"]);
    expect(reauth).not.toHaveBeenCalled();
    expect(msal.login).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    expect(msal.login).toHaveBeenCalledTimes(1);
    expect(requests()).toEqual(["/api/v1/users/me"]);
  });

  it("shows disabled-account denial without an automatic retry or reauthentication loop", async () => {
    freshLogin();
    fetchMock.mockResolvedValueOnce(response({ error: "Disabled", code: "user_disabled" }, 403));
    render(tree());
    await screen.findByText("Account disabled");
    expect(auth.status).toBe("denied");
    expect(auth.isAuthenticated).toBe(false);
    expect(auth.isReady).toBe(false);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(requests()).toEqual(["/api/v1/users/me"]);
    expect(requestMethods()).toEqual(["POST"]);
    expect(msal.consume).not.toHaveBeenCalled();
    expect(reauth).not.toHaveBeenCalled();
    expect(token).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])(
    "retries a 503 explicitly with the original method (fresh login=%s) and deduplicates clicks",
    async (fresh) => {
      if (fresh) freshLogin();
      const path = "/api/v1/users/me";
      const method = fresh ? "POST" : "GET";
      fetchMock.mockResolvedValueOnce(response({ error: "Database unavailable" }, 503));
      const retryResult = deferred<Response>();
      fetchMock.mockImplementationOnce(() => retryResult.promise);
      render(tree());
      await screen.findByText("Unable to connect to Scope");
      expect(auth.status).toBe("error");
      expect(auth.error).toMatchObject({ status: 503 });
      expect(requests()).toEqual([path]);
      expect(requestMethods()).toEqual([method]);
      expect(reauth).not.toHaveBeenCalled();
      expect(msal.consume).not.toHaveBeenCalled();

      act(() => { auth.retry(); auth.retry(); });
      await waitFor(() => expect(requests()).toEqual([path, path]));
      expect(requestMethods()).toEqual([method, method]);
      await act(async () => retryResult.resolve(response(scopeAlice)));
      await waitFor(() => expect(auth.isReady).toBe(true));
      expect(msal.consume).toHaveBeenCalledTimes(fresh ? 1 : 0);
    },
  );

  it("preserves the existing single 401 refresh retry before interactive reauthentication", async () => {
    freshLogin();
    fetchMock.mockImplementation(async () => response({ error: "Invalid JWT" }, 401));
    render(tree());
    await screen.findByText("Unable to connect to Scope");
    expect(requests()).toEqual(["/api/v1/users/me", "/api/v1/users/me"]);
    expect(requestMethods()).toEqual(["POST", "POST"]);
    expect(token).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    expect(reauth).toHaveBeenCalledTimes(1);
    expect(msal.consume).not.toHaveBeenCalled();
    expect(auth.isAuthenticated).toBe(false);
  });

  it("does not automatically replay an enrollment write after a network failure", async () => {
    freshLogin();
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(tree());
    await screen.findByText("Unable to connect to Scope");
    expect(requests()).toEqual(["/api/v1/users/me"]);
    expect(requestMethods()).toEqual(["POST"]);
    expect(msal.pending).toBeDefined();
    expect(msal.consume).not.toHaveBeenCalled();
    expect(reauth).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    { id: "idp-subject", role: "user" },
    { id: "00000000-0000-0000-0000-000000000000" },
    { id: scopeAlice.id, role: ["admin"] },
    { id: scopeAlice.id, displayName: 123 },
  ])("rejects malformed successful user responses: %j", async (body) => {
    freshLogin();
    fetchMock.mockResolvedValueOnce(response(body));
    render(tree());
    await screen.findByText("Unable to connect to Scope");
    expect(auth.error?.message).toBe("Invalid user response from Scope");
    expect(auth.user).toBeNull();
    expect(msal.consume).not.toHaveBeenCalled();
    expect(requests()).toEqual(["/api/v1/users/me"]);
    expect(requestMethods()).toEqual(["POST"]);
  });

  it("cancels a replaced account's handshake and discards its late response and cache", async () => {
    freshLogin();
    const first = deferred<Response>();
    const second = deferred<Response>();
    fetchMock.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const view = render(tree());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const firstRequest = fetchMock.mock.calls[0][0] as Request;
    client.setQueryData(["old-user-data"], { private: true });

    msal.account = { ...alice, localAccountId: "bob-subject", name: "Bob" };
    view.rerender(tree());
    expect(auth.user).toBeNull();
    expect(auth.isReady).toBe(false);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(firstRequest.signal.aborted).toBe(true);
    expect(client.getQueryData(["old-user-data"])).toBeUndefined();
    expect(requests()).toEqual(["/api/v1/users/me", "/api/v1/users/me"]);
    expect(requestMethods()).toEqual(["POST", "GET"]);

    await act(async () => first.resolve(response(scopeAlice)));
    expect(auth.user).toBeNull();
    expect(msal.consume).not.toHaveBeenCalled();
    const bobId = "66666666-7777-4888-9999-aaaaaaaaaaaa";
    await act(async () => second.resolve(response({ id: bobId, role: "user" })));
    await waitFor(() => expect(auth.user?.id).toBe(bobId));
    expect(auth.user?.subject).toBe("bob-subject");
    expect(auth.user?.name).toBe("Bob");
  });

  it("clears an accepted identity, aborts user queries and prevents late cache reuse on logout", async () => {
    const projects = deferred<Response>();
    fetchMock.mockImplementation(async (request: Request) => {
      if (pathOf(request) === "/api/v1/projects") return projects.promise;
      return response(pathOf(request).includes("/users/me") ? scopeAlice : []);
    });
    const view = render(tree());
    await waitFor(() => expect(requests()).toContain("/api/v1/projects"));
    const projectRequest = fetchMock.mock.calls.find(([request]) => pathOf(request) === "/api/v1/projects")![0] as Request;
    client.setQueryData(["private"], "alice");
    await act(async () => auth.logout());
    expect(projectRequest.signal.aborted).toBe(true);
    expect(auth.user).toBeNull();
    expect(auth.account).toBeNull();
    expect(auth.isAuthenticated).toBe(false);
    expect(client.getQueryData(["private"])).toBeUndefined();
    expect(msal.logout).toHaveBeenCalledTimes(1);
    await act(async () => projects.resolve(response([{ id: "alice-project" }])));
    view.rerender(tree());
    expect(client.getQueryData(["projects"])).toBeUndefined();
    expect(auth.status).toBe("signed-out");
    expect(requests().filter((path) => path.includes("/users/me"))).toHaveLength(1);
  });

  it("clears ready-account data and aborts its queries before admitting a switched account", async () => {
    const projects = deferred<Response>();
    const nextLookup = deferred<Response>();
    fetchMock.mockImplementation(async (request: Request) => {
      if (pathOf(request) === "/api/v1/projects") return projects.promise;
      return response(pathOf(request).includes("/users/me") ? scopeAlice : []);
    });
    const view = render(tree());
    await waitFor(() => expect(requests()).toContain("/api/v1/projects"));
    const oldRequest = fetchMock.mock.calls.find(([request]) => pathOf(request) === "/api/v1/projects")![0] as Request;
    client.setQueryData(["private"], "alice");
    fetchMock.mockImplementationOnce(() => nextLookup.promise);
    msal.account = { ...alice, tenantId: "other-tenant", localAccountId: "bob-subject" };
    view.rerender(tree());
    expect(auth.user).toBeNull();
    expect(auth.isReady).toBe(false);
    await waitFor(() => expect(oldRequest.signal.aborted).toBe(true));
    expect(client.getQueryData(["private"])).toBeUndefined();
    await act(async () => projects.resolve(response([{ id: "alice-project" }])));
    expect(client.getQueryData(["projects"])).toBeUndefined();
    expect(auth.user).toBeNull();

    const bobId = "66666666-7777-4888-9999-aaaaaaaaaaaa";
    await act(async () => nextLookup.resolve(response({ id: bobId })));
    await waitFor(() => expect(auth.user?.id).toBe(bobId));
    expect(auth.user?.role).toBeUndefined();
  });

  it("cancels logout during a handshake and ignores a response even if fetch ignores cancellation", async () => {
    freshLogin();
    const lookup = deferred<Response>();
    fetchMock.mockImplementationOnce(() => lookup.promise);
    render(tree());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const request = fetchMock.mock.calls[0][0] as Request;
    await act(async () => auth.logout());
    expect(request.signal.aborted).toBe(true);
    await act(async () => lookup.resolve(response(scopeAlice)));
    expect(auth.user).toBeNull();
    expect(auth.status).toBe("signed-out");
    expect(msal.pending).toBeUndefined();
    expect(msal.consume).not.toHaveBeenCalled();
    expect(requests()).toEqual(["/api/v1/users/me"]);
    expect(requestMethods()).toEqual(["POST"]);
  });

  it("aborts a handshake on a real unmount, unlike StrictMode's effect replay", async () => {
    const lookup = deferred<Response>();
    fetchMock.mockImplementationOnce(() => lookup.promise);
    const view = render(tree());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const request = fetchMock.mock.calls[0][0] as Request;
    expect(request.signal.aborted).toBe(false);
    view.unmount();
    await act(async () => {});
    expect(request.signal.aborted).toBe(true);
    await act(async () => lookup.resolve(response(scopeAlice)));
    expect(msal.consume).not.toHaveBeenCalled();
  });
});
