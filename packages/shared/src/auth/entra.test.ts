// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createServer } from "node:http";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, SignJWT, generateKeyPair } from "jose";
import type {
  JSONWebKeySet,
  JWTVerifyGetKey,
  KeyLike,
} from "jose";
import { EntraIdAuthProvider, type EntraJwks } from "./entra.js";
import { AuthError } from "./types.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "99999999-9999-9999-9999-999999999999";
const SUBJECT = "22222222-2222-2222-2222-222222222222";
const AUDIENCE = "api-client-id";
const AUTHORITY = "https://login.microsoftonline.com/common";
const KEY_ID = "test-signing-key";
const KEY_ISSUER = "https://login.microsoftonline.com/{tenantid}/v2.0";

let privateKey: KeyLike;
let publicKey: KeyLike;
let wrongPrivateKey: KeyLike;
let publicJwk: JSONWebKeySet["keys"][number];

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function basePayload(): Record<string, unknown> {
  const now = nowSeconds();
  return {
    aud: AUDIENCE,
    iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
    tid: TENANT,
    oid: SUBJECT,
    name: "Ada Lovelace",
    preferred_username: "ada@example.com",
    email_verified: true,
    iat: now,
    nbf: now,
    exp: now + 3600,
  };
}

async function sign(
  payload: Record<string, unknown>,
  key: KeyLike = privateKey,
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: KEY_ID })
    .sign(key);
}

function makeJwks(
  issuer: unknown = KEY_ISSUER,
  includeIssuer = true,
  resolve?: JWTVerifyGetKey,
): EntraJwks {
  const key = {
    ...publicJwk,
    alg: "RS256",
    use: "sig",
    kid: KEY_ID,
    ...(includeIssuer ? { issuer } : {}),
  };
  const jwks = { keys: [key] };
  return {
    resolve: resolve ?? createLocalJWKSet(jwks),
    getCurrentJwks: () => jwks,
  };
}

function makeProvider(
  issuer: unknown = KEY_ISSUER,
  includeIssuer = true,
): EntraIdAuthProvider {
  return new EntraIdAuthProvider({
    authority: AUTHORITY,
    audience: AUDIENCE,
    jwks: makeJwks(issuer, includeIssuer),
  });
}

beforeAll(async () => {
  ({ privateKey, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  }));
  ({ privateKey: wrongPrivateKey } = await generateKeyPair("RS256", {
    extractable: true,
  }));
  publicJwk = await exportJWK(publicKey);
});

describe("EntraIdAuthProvider.verifyAccessToken", () => {
  it("verifies a valid token and extracts identity claims", async () => {
    const token = await sign(basePayload());
    const identity = await makeProvider().verifyAccessToken(token);

    expect(identity).toEqual({
      idp: "entra",
      idpTenant: TENANT,
      idpSubject: SUBJECT,
      email: "ada@example.com",
      displayName: "Ada Lovelace",
      emailVerified: true,
    });
  });

  it("retains issuer metadata from the cached remote JWKS", async () => {
    const jwks = makeJwks().getCurrentJwks();
    if (!jwks) throw new Error("Test JWKS is unavailable");

    let requestCount = 0;
    const server = createServer((_request, response) => {
      requestCount += 1;
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(jwks));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Test JWKS server has no TCP address");
      }
      const provider = new EntraIdAuthProvider({
        authority: AUTHORITY,
        audience: AUDIENCE,
        jwksUri: `http://127.0.0.1:${address.port}/keys`,
      });
      const token = await sign(basePayload());

      await expect(provider.verifyAccessToken(token)).resolves.toMatchObject({
        idpTenant: TENANT,
      });
      await expect(provider.verifyAccessToken(token)).resolves.toMatchObject({
        idpTenant: TENANT,
      });
      expect(requestCount).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("prefers the `email` claim over `preferred_username`", async () => {
    const token = await sign({
      ...basePayload(),
      email: "ada.primary@example.com",
    });
    const identity = await makeProvider().verifyAccessToken(token);
    expect(identity.email).toBe("ada.primary@example.com");
  });

  it("rejects a token signed by a different key (bad signature)", async () => {
    const token = await sign(basePayload(), wrongPrivateKey);
    await expect(makeProvider().verifyAccessToken(token)).rejects.toMatchObject(
      { name: "AuthError", code: "invalid_token" },
    );
  });

  it.each(["ERR_JWKS_TIMEOUT", "ECONNRESET"])(
    "retries one transient JWKS retrieval failure (%s)",
    async (code) => {
      const token = await sign(basePayload());
      const jwks = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error("JWKS unavailable"), { code }))
        .mockResolvedValueOnce(publicKey);
      const provider = new EntraIdAuthProvider({
        authority: AUTHORITY,
        audience: AUDIENCE,
        jwks: makeJwks(KEY_ISSUER, true, jwks),
      });

      await expect(provider.verifyAccessToken(token)).resolves.toMatchObject({
        idpSubject: SUBJECT,
      });
      expect(jwks).toHaveBeenCalledTimes(2);
    },
  );

  it("returns service_unavailable after the bounded JWKS retry is exhausted", async () => {
    const token = await sign(basePayload());
    const error = Object.assign(new Error("JWKS request timed out"), {
      code: "ERR_JWKS_TIMEOUT",
    });
    const jwks = vi.fn().mockRejectedValue(error);
    const provider = new EntraIdAuthProvider({
      authority: AUTHORITY,
      audience: AUDIENCE,
      jwks: makeJwks(KEY_ISSUER, true, jwks),
    });

    await expect(provider.verifyAccessToken(token)).rejects.toMatchObject({
      name: "AuthError",
      code: "service_unavailable",
    });
    expect(jwks).toHaveBeenCalledTimes(2);
  });

  it("does not retry a JWKS key-selection failure", async () => {
    const token = await sign(basePayload());
    const error = Object.assign(new Error("no applicable key found"), {
      code: "ERR_JWKS_NO_MATCHING_KEY",
    });
    const jwks = vi.fn().mockRejectedValue(error);
    const provider = new EntraIdAuthProvider({
      authority: AUTHORITY,
      audience: AUDIENCE,
      jwks: makeJwks(KEY_ISSUER, true, jwks),
    });

    await expect(provider.verifyAccessToken(token)).rejects.toMatchObject({
      name: "AuthError",
      code: "invalid_token",
    });
    expect(jwks).toHaveBeenCalledOnce();
  });

  it("rejects an expired token", async () => {
    const now = nowSeconds();
    const token = await sign({
      ...basePayload(),
      iat: now - 7200,
      nbf: now - 7200,
      exp: now - 3600,
    });
    await expect(makeProvider().verifyAccessToken(token)).rejects.toMatchObject(
      { name: "AuthError", code: "expired_token" },
    );
  });

  it("rejects a token with the wrong audience", async () => {
    const token = await sign({ ...basePayload(), aud: "some-other-api" });
    await expect(makeProvider().verifyAccessToken(token)).rejects.toMatchObject(
      { name: "AuthError", code: "invalid_audience" },
    );
  });

  it("rejects a token whose issuer does not match its tenant", async () => {
    const token = await sign({
      ...basePayload(),
      iss: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0`,
    });
    await expect(makeProvider().verifyAccessToken(token)).rejects.toMatchObject(
      { name: "AuthError", code: "invalid_issuer" },
    );
  });

  it("accepts an exact signing key issuer for the token tenant", async () => {
    const token = await sign(basePayload());
    const identity = await makeProvider(
      `https://login.microsoftonline.com/${TENANT}/v2.0`,
    ).verifyAccessToken(token);

    expect(identity.idpTenant).toBe(TENANT);
  });

  it("validates the issuer of the selected key, not unrelated JWKS entries", async () => {
    const jwks = makeJwks();
    jwks.getCurrentJwks()?.keys.push({
      ...publicJwk,
      alg: "RS256",
      use: "sig",
      kid: "unrelated-key",
      issuer: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0`,
    });
    const provider = new EntraIdAuthProvider({
      authority: AUTHORITY,
      audience: AUDIENCE,
      jwks,
    });

    await expect(provider.verifyAccessToken(await sign(basePayload()))).resolves
      .toMatchObject({ idpTenant: TENANT });
  });

  it("rejects a signing key restricted to another tenant", async () => {
    const token = await sign(basePayload());
    await expect(
      makeProvider(
        `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0`,
      ).verifyAccessToken(token),
    ).rejects.toMatchObject({
      name: "AuthError",
      code: "invalid_issuer",
    });
  });

  it.each([
    ["missing", undefined, false],
    ["empty", "", true],
    ["non-string", 42, true],
  ])(
    "rejects a selected signing key with %s issuer metadata",
    async (_description, issuer, includeIssuer) => {
      const token = await sign(basePayload());
      await expect(
        makeProvider(issuer, includeIssuer).verifyAccessToken(token),
      ).rejects.toMatchObject({
        name: "AuthError",
        code: "invalid_issuer",
      });
    },
  );

  it("rejects a token missing the `oid` claim", async () => {
    const payload = basePayload();
    delete payload.oid;
    const token = await sign(payload);
    await expect(
      makeProvider().verifyAccessToken(token),
    ).rejects.toBeInstanceOf(AuthError);
    await expect(makeProvider().verifyAccessToken(token)).rejects.toMatchObject(
      { code: "missing_claim" },
    );
  });

  it("accepts any tenant (multi-tenant) as long as issuer matches tid", async () => {
    const token = await sign({
      ...basePayload(),
      tid: OTHER_TENANT,
      iss: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0`,
    });
    const identity = await makeProvider().verifyAccessToken(token);
    expect(identity.idpTenant).toBe(OTHER_TENANT);
  });

  it("validates a self-hosted issuer via issuerTemplate (entra-local)", async () => {
    // The entra-local emulator mints `iss: https://localhost:8443/{tid}/v2.0`,
    // which does not match the Entra-cloud default template.
    const provider = new EntraIdAuthProvider({
      authority: "https://localhost:8443/common",
      audience: AUDIENCE,
      issuerTemplate: "https://localhost:8443/{tenantid}/v2.0",
      jwks: makeJwks("https://localhost:8443/{tenantid}/v2.0"),
    });
    const token = await sign({
      ...basePayload(),
      iss: `https://localhost:8443/${TENANT}/v2.0`,
    });
    const identity = await provider.verifyAccessToken(token);
    expect(identity.idpTenant).toBe(TENANT);

    // The same token is rejected by a provider using the cloud default template.
    await expect(
      makeProvider().verifyAccessToken(token),
    ).rejects.toMatchObject({ name: "AuthError", code: "invalid_issuer" });
  });
});
