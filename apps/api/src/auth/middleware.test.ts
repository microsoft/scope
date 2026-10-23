// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { AuthError, mintRunToken, type AuthProvider, type VerifiedIdentity } from "shared";
import { createAuthMiddleware, createUserAccessMiddleware } from "./middleware.js";
import { authErrorHandler } from "./error-handler.js";
import { getPrincipal, getUser } from "./types.js";
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

describe("run-token and service-key callers", () => {
  const runToken = mintRunToken("req-1").token;
  const verifiedRun = { requestId: "req-1", runId: "run-1", projectId: "project-1", tokenHash: "abcdef0123456789" };

  function setupCallers(opts: { providerEnabled?: boolean; withVerifiers?: boolean } = {}) {
    const { providerEnabled = true, withVerifiers = true } = opts;
    const provider = {
      id: "entra",
      verifyAccessToken: vi.fn(async () => identity),
    } satisfies AuthProvider;
    const resolver = {
      resolveExisting: vi.fn(async () => principal),
      enrollOnLogin: vi.fn(async () => principal),
    } satisfies UserAccessService;
    const runVerifier = vi.fn(async (token: string) => {
      if (token !== runToken) throw new AuthError("invalid_run_token", "Invalid run token");
      return verifiedRun;
    });
    const serviceVerifier = vi.fn((name: string, key: string) => {
      if (name !== "register-agents" || key !== "k".repeat(40)) {
        throw new AuthError("invalid_service_key", "Invalid service credentials");
      }
      return { name, scopes: ["agents:register"] };
    });
    const app = express();
    app.use(createAuthMiddleware({
      getProvider: () => providerEnabled ? provider : null,
      getRunTokenVerifier: () => withVerifiers ? runVerifier : null,
      getServiceKeyVerifier: () => withVerifiers ? serviceVerifier : null,
    }));
    app.use(createUserAccessMiddleware(() => resolver));
    app.get("/api/v1/private", (req, res) => {
      res.json({ principal: getPrincipal(req), user: getUser(req), hasAuth: req.auth !== undefined });
    });
    app.use(authErrorHandler);
    return { app, provider, resolver, runVerifier, serviceVerifier };
  }

  it("attaches a verified run caller without IdP verification or user access", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const { app, provider, resolver, runVerifier } = setupCallers();
    const res = await request(app).get("/api/v1/private").set("Authorization", `Bearer ${runToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      principal: { kind: "run", requestId: "req-1", runId: "run-1", projectId: "project-1" },
      user: { id: "anonymous", isAuthenticated: false },
      hasAuth: false,
    });
    expect(runVerifier).toHaveBeenCalledWith(runToken);
    expect(provider.verifyAccessToken).not.toHaveBeenCalled();
    expect(resolver.resolveExisting).not.toHaveBeenCalled();
    // The caller is logged with an 8-char digest prefix, never the raw token.
    const logged = debug.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("run caller request=req-1 run=run-1 token=abcdef01");
    expect(logged).not.toContain(runToken);
    debug.mockRestore();
  });

  it.each([
    ["invalid_run_token"],
    ["run_not_active"],
    ["run_token_expired"],
  ] as const)("rejects a run token failing with %s as 401", async (code) => {
    const { app, runVerifier, provider } = setupCallers();
    runVerifier.mockRejectedValueOnce(new AuthError(code, "nope"));
    const res = await request(app).get("/api/v1/private").set("Authorization", `Bearer ${runToken}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(code);
    expect(provider.verifyAccessToken).not.toHaveBeenCalled();
  });

  it("rejects a forged run token as 401", async () => {
    const { app } = setupCallers();
    const forged = mintRunToken("req-1").token;
    const res = await request(app).get("/api/v1/private").set("Authorization", `Bearer ${forged}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("invalid_run_token");
  });

  it("returns 503 when run-token verification is unavailable", async () => {
    const { app, runVerifier } = setupCallers();
    runVerifier.mockRejectedValueOnce(new AuthError("service_unavailable", "down"));
    const res = await request(app).get("/api/v1/private").set("Authorization", `Bearer ${runToken}`);
    expect(res.status).toBe(503);
  });

  it("rejects run tokens when no verifier is configured", async () => {
    const { app } = setupCallers({ withVerifiers: false });
    const res = await request(app).get("/api/v1/private").set("Authorization", `Bearer ${runToken}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("invalid_run_token");
  });

  it("attaches a verified service caller", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const { app, provider, resolver } = setupCallers();
    const res = await request(app)
      .get("/api/v1/private")
      .set("X-Service-Name", "register-agents")
      .set("X-Internal-Key", "k".repeat(40));
    expect(res.status).toBe(200);
    expect(res.body.principal).toEqual({ kind: "service", name: "register-agents", scopes: ["agents:register"] });
    expect(res.body.user).toEqual({ id: "anonymous", isAuthenticated: false });
    expect(provider.verifyAccessToken).not.toHaveBeenCalled();
    expect(resolver.resolveExisting).not.toHaveBeenCalled();
    expect(debug.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("k".repeat(40));
    debug.mockRestore();
  });

  it.each([
    [{ "X-Service-Name": "register-agents", "X-Internal-Key": "wrong" }],
    [{ "X-Service-Name": "register-agents" }],
    [{ "X-Internal-Key": "k".repeat(40) }],
  ])("rejects incomplete or wrong service credentials %j as 401", async (headers) => {
    const { app } = setupCallers();
    const res = await request(app).get("/api/v1/private").set(headers);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("invalid_service_key");
  });

  it("fails closed for service headers when no service verifier is configured", async () => {
    const { app } = setupCallers({ withVerifiers: false });
    const res = await request(app)
      .get("/api/v1/private")
      .set("X-Service-Name", "register-agents")
      .set("X-Internal-Key", "k".repeat(40));
    expect(res.status).toBe(401);
  });

  it("rejects service headers combined with an Authorization header", async () => {
    const { app, serviceVerifier, provider } = setupCallers();
    const res = await request(app)
      .get("/api/v1/private")
      .set("Authorization", `Bearer ${runToken}`)
      .set("X-Service-Name", "register-agents")
      .set("X-Internal-Key", "k".repeat(40));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("ambiguous_credentials");
    expect(serviceVerifier).not.toHaveBeenCalled();
    expect(provider.verifyAccessToken).not.toHaveBeenCalled();
  });

  it("keeps no-credential requests anonymous", async () => {
    const { app, runVerifier, serviceVerifier } = setupCallers();
    const res = await request(app).get("/api/v1/private");
    expect(res.status).toBe(200);
    expect(res.body.principal).toEqual({ kind: "anonymous" });
    expect(runVerifier).not.toHaveBeenCalled();
    expect(serviceVerifier).not.toHaveBeenCalled();
  });

  it("still sends IdP bearers to the provider and resolves the user", async () => {
    const { app, provider, runVerifier } = setupCallers();
    const res = await request(app).get("/api/v1/private").set("Authorization", "Bearer idp-token");
    expect(res.status).toBe(200);
    expect(res.body.principal).toEqual({ kind: "user", user: principal });
    expect(res.body.hasAuth).toBe(true);
    expect(provider.verifyAccessToken).toHaveBeenCalledWith("idp-token");
    expect(runVerifier).not.toHaveBeenCalled();
  });

  it("ignores run and service credentials while auth is disabled", async () => {
    const { app, runVerifier, serviceVerifier } = setupCallers({ providerEnabled: false });
    const run = await request(app).get("/api/v1/private").set("Authorization", `Bearer ${runToken}`);
    const svc = await request(app)
      .get("/api/v1/private")
      .set("X-Service-Name", "register-agents")
      .set("X-Internal-Key", "wrong");
    for (const res of [run, svc]) {
      expect(res.status).toBe(200);
      expect(res.body.principal).toEqual({ kind: "anonymous" });
    }
    expect(runVerifier).not.toHaveBeenCalled();
    expect(serviceVerifier).not.toHaveBeenCalled();
  });
});
