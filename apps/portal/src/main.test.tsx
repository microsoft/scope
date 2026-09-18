// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import type { AccountInfo } from "@azure/msal-browser";
import { act, screen, waitFor } from "@testing-library/react";
import { useQuery } from "@tanstack/react-query";
import type { Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { resetApiClient, setApiTokenProvider } from "@/lib/api-client";
import { useFavicon } from "@/hooks/useFavicon";

const bootstrap = vi.hoisted(() => ({
  root: null as Root | null,
  event: { accountKey: "callback-account" },
}));
const account: AccountInfo = {
  homeAccountId: "home", localAccountId: "subject", tenantId: "tenant",
  environment: "login.example.test", username: "alice@example.test",
};

vi.mock("react-dom/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom/client")>();
  return {
    ...actual,
    createRoot: (container: HTMLElement) => {
      bootstrap.root = actual.createRoot(container);
      return bootstrap.root;
    },
  };
});

vi.mock("@azure/msal-react", () => ({
  MsalProvider: ({ children }: { children: ReactNode }) => children,
  useMsal: () => ({ accounts: [account], inProgress: "none" }),
  useAccount: () => account,
}));

vi.mock("@/lib/auth/msalInstance", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/auth/msalInstance")>(),
  initializeAuth: async () => {},
  isAuthEnabled: true,
  isAuthConfigured: true,
  getPendingRedirectLogin: () => bootstrap.event,
  consumeRedirectLogin: vi.fn(),
  discardRedirectLogin: vi.fn(),
}));

vi.mock("@/lib/auth/wireApiAuth", () => ({
  wireApiAuth: () => setApiTokenProvider(() => "idp-token"),
}));

vi.mock("@/App", () => ({
  App: () => {
    // Match App's eager favicon effect plus an unconditionally mounted page.
    useFavicon();
    useQuery({ queryKey: ["projects"], queryFn: () => api.listProjects() });
    return <div>Bootstrapped app</div>;
  },
}));

afterEach(async () => {
  await act(async () => bootstrap.root?.unmount());
  document.body.innerHTML = "";
  resetApiClient();
  vi.unstubAllGlobals();
});

it("the real bootstrap/provider tree sends no flags, favicon or page requests before the login response", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  let resolve!: (response: Response) => void;
  const lookup = new Promise<Response>((done) => { resolve = done; });
  const requests: string[] = [];
  const fetchMock = vi.fn((request: Request) => {
    const url = new URL(request.url);
    const path = url.pathname + url.search;
    requests.push(`${request.method} ${path}`);
    if (request.method === "POST" && path === "/api/v1/users/me") return lookup;
    return Promise.resolve(new Response("[]"));
  });
  vi.stubGlobal("fetch", fetchMock);
  await act(async () => { await import("./main"); });
  await waitFor(() => expect(requests).toEqual(["POST /api/v1/users/me"]));
  expect(screen.queryByText("Bootstrapped app")).toBeNull();

  await act(async () => resolve(new Response(JSON.stringify({
    id: "11111111-2222-4333-8444-555555555555", role: "user",
  }))));
  await screen.findByText("Bootstrapped app");
  await waitFor(() => expect(requests).toEqual(expect.arrayContaining([
    "GET /api/v1/feature-flags", "GET /api/v1/version", "GET /api/v1/projects",
  ])));
  expect(requests[0]).toBe("POST /api/v1/users/me");
  expect(requests.filter((entry) => entry.includes("/users/me"))).toHaveLength(1);
});
