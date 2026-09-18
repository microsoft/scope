// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { AuthError, type AuthProvider, type VerifiedIdentity } from "shared";
import { createAuthMiddleware, createUserAccessMiddleware } from "./middleware.js";
import { authErrorHandler } from "./error-handler.js";
import { getUser } from "./types.js";
import { UserAccessError, type UserAccessService } from "./user-access-resolver.js";

const identity: VerifiedIdentity = {
  idp: "entra",
  idpTenant: "tenant-1",
  idpSubject: "subject-1",
};
const principal = {
  id: "scope-user",
  isAuthenticated: true,
  role: "user",
  ...identity,
};

function setup(providerEnabled = true, resolverEnabled = true) {
  const provider = {
    id: "entra",
    verifyAccessToken: vi.fn(async () => identity),
  } satisfies AuthProvider;
  const resolver = {
    resolveExisting: vi.fn(async () => principal),
    enrollOnLogin: vi.fn(async () => principal),
  } satisfies UserAccessService;
  const app = express();
  app.use(createAuthMiddleware({ getProvider: () => providerEnabled ? provider : null }));
  app.get("/verified-only", (req, res) => {
    res.json({ identity: req.auth?.identity, user: req.user });
  });
  app.use(createUserAccessMiddleware(() => resolverEnabled ? resolver : null));
  app.get(["/api/v1/private", "/health", "/ready", "/api-docs/test"], (req, res) => {
    res.json(getUser(req));
  });
  app.use(authErrorHandler);
  return { app, provider, resolver };
}

describe("IdP verification and application access middleware", () => {
  it.each(["/health", "/ready", "/api-docs/test"])("skips public path %s", async (path) => {
    const { app, provider, resolver } = setup();
    expect((await request(app).get(path).set("Authorization", "Bearer bad")).status).toBe(200);
    expect(provider.verifyAccessToken).not.toHaveBeenCalled();
    expect(resolver.resolveExisting).not.toHaveBeenCalled();
  });

  it("preserves anonymous callers without a token", async () => {
    const { app, provider, resolver } = setup();
    const res = await request(app).get("/api/v1/private");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "anonymous", isAuthenticated: false });
    expect(provider.verifyAccessToken).not.toHaveBeenCalled();
    expect(resolver.resolveExisting).not.toHaveBeenCalled();
    expect(resolver.enrollOnLogin).not.toHaveBeenCalled();
  });

  it("preserves anonymous mode without an IdP provider", async () => {
    const { app, resolver } = setup(false);
    const res = await request(app).get("/api/v1/private").set("Authorization", "Bearer token");
    expect(res.body.id).toBe("anonymous");
    expect(resolver.resolveExisting).not.toHaveBeenCalled();
  });

  it.each(["bearer token", "bEaReR token", "bearer   token"])(
    "makes verified identity available before access resolution for %s", async (header) => {
      const { app, provider, resolver } = setup();
      const res = await request(app).get("/verified-only").set("Authorization", header);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ identity });
      expect(provider.verifyAccessToken).toHaveBeenCalledWith("token");
      expect(resolver.resolveExisting).not.toHaveBeenCalled();
      expect(resolver.enrollOnLogin).not.toHaveBeenCalled();
    },
  );

  it("verifies before resolving and never enrolls from a normal route", async () => {
    const { app, provider, resolver } = setup();
    const res = await request(app).get("/api/v1/private?login=true").set("Authorization", "Bearer token");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(principal);
    expect(resolver.resolveExisting).toHaveBeenCalledExactlyOnceWith(identity);
    expect(provider.verifyAccessToken.mock.invocationCallOrder[0]).toBeLessThan(
      resolver.resolveExisting.mock.invocationCallOrder[0],
    );
    expect(resolver.enrollOnLogin).not.toHaveBeenCalled();
  });

  it.each(["invalid_token", "expired_token", "invalid_audience"] as const)(
    "rejects %s before any access lookup", async (code) => {
      const { app, provider, resolver } = setup();
      provider.verifyAccessToken.mockRejectedValue(new AuthError(code, "bad token"));
      const res = await request(app).get("/api/v1/private").set("Authorization", "Bearer token");
      expect(res.status).toBe(401);
      expect(res.body.code).toBe(code);
      expect(resolver.resolveExisting).not.toHaveBeenCalled();
    },
  );

  it.each(["Basic value", "Bearer", "Bearer token extra"])(
    "rejects malformed credentials %s instead of downgrading to anonymous", async (header) => {
      const { app, provider, resolver } = setup();
      const res = await request(app).get("/api/v1/private").set("Authorization", header);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("invalid_token");
      expect(provider.verifyAccessToken).not.toHaveBeenCalled();
      expect(resolver.resolveExisting).not.toHaveBeenCalled();
      expect(resolver.enrollOnLogin).not.toHaveBeenCalled();
    },
  );

  it.each(["", " ", "\t", "Bearer ", "Bearer   "])(
    "rejects empty credentials %j instead of downgrading to anonymous", async (header) => {
      const { app, provider, resolver } = setup();
      const res = await request(app).get("/api/v1/private").set("Authorization", header);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("invalid_token");
      expect(provider.verifyAccessToken).not.toHaveBeenCalled();
      expect(resolver.resolveExisting).not.toHaveBeenCalled();
      expect(resolver.enrollOnLogin).not.toHaveBeenCalled();
    },
  );

  it("returns 503 for unavailable JWKS before looking up access", async () => {
    const { app, provider, resolver } = setup();
    provider.verifyAccessToken.mockRejectedValue(new AuthError("service_unavailable", "JWKS unavailable"));
    const res = await request(app).get("/api/v1/private").set("Authorization", "Bearer token");
    expect(res.status).toBe(503);
    expect(resolver.resolveExisting).not.toHaveBeenCalled();
  });

  it("returns 503 if the access resolver has not initialized", async () => {
    const { app, provider } = setup(true, false);
    const res = await request(app).get("/api/v1/private").set("Authorization", "Bearer token");
    expect(res.status).toBe(503);
    expect(provider.verifyAccessToken).toHaveBeenCalledOnce();
  });

  it.each([
    ["user_not_enrolled", 403],
    ["user_disabled", 403],
    ["invalid_principal", 401],
    ["service_unavailable", 503],
  ] as const)("maps resolver failure %s to %s", async (code, status) => {
    const { app, resolver } = setup();
    resolver.resolveExisting.mockRejectedValue(new UserAccessError(code));
    const res = await request(app).get("/api/v1/private").set("Authorization", "Bearer token");
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
  });
});
