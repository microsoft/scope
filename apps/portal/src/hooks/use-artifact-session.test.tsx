// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { StrictMode } from "react";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiSessionSignal, resetApiClient } from "@/lib/api-client";
import { useArtifactSession } from "./use-artifact-session";

const state = vi.hoisted(() => ({
  project: "p1" as string | undefined,
  auth: { isReady: true, user: { id: "u1" }, account: {
    homeAccountId: "home", localAccountId: "local", tenantId: "tenant", environment: "idp",
  } },
}));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => state.auth }));
vi.mock("@/contexts/ProjectContext", () => ({ useSelectedProjectId: () => state.project }));

beforeEach(() => {
  state.project = "p1";
  state.auth.isReady = true;
  state.auth.user.id = "u1";
  state.auth.account.homeAccountId = "home";
});
afterEach(() => { cleanup(); resetApiClient(); });

describe("artifact session identity", () => {
  it("is stable for unrelated rerenders and replaces identity for each attempt", () => {
    const { result, rerender } = renderHook(({ resource }) => useArtifactSession(resource), {
      initialProps: { resource: "request/attempt-1" },
    });
    const first = result.current;
    rerender({ resource: "request/attempt-1" });
    expect(result.current).toBe(first);
    rerender({ resource: "request/attempt-2" });
    expect(first.controller.signal.aborted).toBe(true);
    expect(result.current.controller.signal.aborted).toBe(false);
    expect(result.current.key).not.toEqual(first.key);
  });

  it.each(["project", "user", "account", "logout"] as const)("aborts and isolates on %s change", change => {
    const { result, rerender } = renderHook(() => useArtifactSession("request/attempt"));
    const first = result.current;
    if (change === "project") state.project = "p2";
    if (change === "user") state.auth.user.id = "u2";
    if (change === "account") state.auth.account.homeAccountId = "home2";
    if (change === "logout") state.auth.isReady = false;
    rerender();
    expect(first.controller.signal.aborted).toBe(true);
    expect(result.current).not.toBe(first);
    expect(result.current.ready).toBe(change !== "logout");
  });

  it("cancels immediately on global account abort, before any rerender", () => {
    const account = new AbortController();
    setApiSessionSignal(account.signal);
    const { result } = renderHook(() => useArtifactSession("r/a"));
    expect(result.current.accountSignal).toBe(account.signal);
    account.abort();
    expect(result.current.controller.signal.aborted).toBe(true);
  });

  it("survives StrictMode replay and aborts on unmount", () => {
    const { result, unmount } = renderHook(() => useArtifactSession("r/a"), { wrapper: StrictMode });
    const signal = result.current.controller.signal;
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
  });

  it("isolates a new login epoch even when the same account signs in again", () => {
    setApiSessionSignal(new AbortController().signal);
    const { result, rerender } = renderHook(() => useArtifactSession("r/a"));
    const first = result.current;
    setApiSessionSignal(new AbortController().signal);
    rerender();
    expect(first.controller.signal.aborted).toBe(true);
    expect(result.current.key).not.toEqual(first.key);
  });

  it("does not enable requests without a selected project or with a cancelled account", () => {
    state.project = undefined;
    const account = new AbortController();
    account.abort();
    setApiSessionSignal(account.signal);
    const { result } = renderHook(() => useArtifactSession("r/a"));
    expect(result.current.ready).toBe(false);
    expect(result.current.controller.signal.aborted).toBe(true);
  });
});
