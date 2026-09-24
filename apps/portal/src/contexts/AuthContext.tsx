// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useAccount, useMsal } from "@azure/msal-react";
import type { AccountInfo } from "@azure/msal-browser";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type CurrentUserResponse } from "@/lib/api";
import { setApiSessionSignal } from "@/lib/api-client";
import {
  consumeRedirectLogin,
  discardRedirectLogin,
  getAccountKey,
  getPendingRedirectLogin,
  isAuthEnabled,
  login as msalLogin,
  logout as msalLogout,
} from "@/lib/auth/msalInstance";

/** Scope owns the ID and role; IdP fields are display/compatibility fallbacks. */
export interface AuthUser extends CurrentUserResponse {
  name: string;
  username: string;
  subject: string;
}

export type AuthStatus = "signed-out" | "resolving" | "ready" | "denied" | "error";

interface AuthContextValue {
  account: AccountInfo | null;
  user: AuthUser | null;
  status: AuthStatus;
  error: Error | null;
  isAuthenticated: boolean;
  /** Scope has accepted this account (or auth is disabled). */
  isReady: boolean;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  /** Retry a failed lookup, preserving any unconsumed redirect login event. */
  retry: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/**
 * Raw auth context. Exported so stories/tests can provide a deterministic value
 * without standing up MSAL. Application code should use {@link useAuth}.
 */
export { AuthContext };
export type { AuthContextValue };

function toUser(account: AccountInfo, scopeUser: CurrentUserResponse): AuthUser {
  const username = account.username || "";
  return {
    ...scopeUser,
    name: scopeUser.displayName || account.name || username || scopeUser.email || "Signed in",
    username,
    subject: account.localAccountId || account.homeAccountId || username,
  };
}

interface Session {
  key: string;
  controller: AbortController;
  status: AuthStatus;
}

interface Snapshot {
  key: string;
  status: AuthStatus;
  user: AuthUser | null;
  error: Error | null;
}

export interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const { accounts, inProgress } = useMsal();
  // useMsal alone does not rerender when only the active account changes.
  const activeAccount = useAccount();
  const queryClient = useQueryClient();
  const session = useRef<Session | null>(null);
  const mounted = useRef(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const account = signedOut || inProgress === "logout"
    ? null
    : accounts.find((candidate) => activeAccount && getAccountKey(candidate) === getAccountKey(activeAccount))
      ?? accounts[0] ?? null;
  const key = isAuthEnabled && account ? getAccountKey(account) : null;
  const canResolve = inProgress === "none";

  const clearSession = useCallback((discardLogin = true) => {
    const previous = session.current;
    session.current = null;
    previous?.controller.abort();
    if (previous && discardLogin) discardRedirectLogin(previous.key);
    setApiSessionSignal(isAuthEnabled ? AbortSignal.abort() : undefined);
    void queryClient.cancelQueries();
    queryClient.clear();
  }, [queryClient]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // StrictMode immediately reattaches effects. Keep its in-flight request,
      // but cancel on an actual unmount without allowing late results through.
      queueMicrotask(() => {
        if (!mounted.current) clearSession();
      });
    };
  }, [clearSession]);

  useEffect(() => {
    if (!isAuthEnabled) return;
    if (session.current?.key !== key) {
      clearSession();
      setSnapshot(null);
    }
    if (!account || !key || !canResolve || session.current) return;

    const current: Session = { key, controller: new AbortController(), status: "resolving" };
    const redirectLogin = getPendingRedirectLogin(account);
    session.current = current;
    setApiSessionSignal(current.controller.signal);
    setSnapshot({ key, status: "resolving", user: null, error: null });
    const isCurrent = () =>
      mounted.current && session.current === current && !current.controller.signal.aborted;

    // Deliberately outside React Query: no focus/reconnect or automatic retries
    // may repeat the enrollment POST's database writes.
    const resolveUser = redirectLogin ? api.enrollCurrentUser : api.getCurrentUser;
    void resolveUser({
      signal: current.controller.signal,
    }).then((user) => {
      if (!isCurrent()) return;
      if (redirectLogin) consumeRedirectLogin(redirectLogin);
      current.status = "ready";
      setSnapshot({ key, status: "ready", user: toUser(account, user), error: null });
    }, (cause: unknown) => {
      if (!isCurrent()) return;
      const error = cause instanceof Error ? cause : new Error("Unable to connect to Scope");
      current.status = error instanceof ApiError && error.status === 403 ? "denied" : "error";
      setSnapshot({ key, status: current.status, user: null, error });
    });
  }, [account, key, canResolve, attempt, clearSession]);

  const logout = useCallback(async () => {
    clearSession();
    setSignedOut(true);
    setSnapshot(null);
    await msalLogout();
  }, [clearSession]);

  const retry = useCallback(() => {
    if (!session.current || !["denied", "error"].includes(session.current.status)) return;
    clearSession(false);
    setSnapshot(null);
    setAttempt((value) => value + 1);
  }, [clearSession]);

  // Account changes gate children during render, before cleanup effects run.
  const active = key && snapshot?.key === key ? snapshot : null;
  const status: AuthStatus = !isAuthEnabled ? "ready"
    : active?.status ?? (account || (!signedOut && !canResolve && inProgress !== "logout")
      ? "resolving" : "signed-out");
  const user = active?.user ?? null;
  const value: AuthContextValue = {
    account,
    user,
    status,
    error: active?.error ?? null,
    isAuthenticated: status === "ready" && user !== null,
    isReady: status === "ready",
    login: msalLogin,
    logout,
    retry,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
