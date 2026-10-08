// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { AuthContextValue } from "./AuthContext";

/** Deterministic contexts for isolated stories/tests; never perform a handshake. */
export const signedOutAuth: AuthContextValue = {
  account: null,
  user: null,
  status: "signed-out",
  error: null,
  isAuthenticated: false,
  isReady: false,
  login: async () => {},
  logout: async () => {},
  retry: () => {},
};

export const signedInAuth: AuthContextValue = {
  ...signedOutAuth,
  status: "ready",
  isAuthenticated: true,
  isReady: true,
  account: {
    homeAccountId: "alice-home",
    localAccountId: "alice-subject",
    tenantId: "demo-tenant",
    environment: "login.example.test",
    username: "alice@entralocal.dev",
    name: "Alice Anderson",
  },
  user: {
    id: "11111111-2222-4333-8444-555555555555",
    role: "user",
    name: "Alice Anderson",
    displayName: "Alice Anderson",
    username: "alice@entralocal.dev",
    subject: "alice-subject",
  },
};
