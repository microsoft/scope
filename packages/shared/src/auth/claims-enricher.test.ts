// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { ClaimsProfileEnricher } from "./claims-enricher.js";
import type { VerifiedIdentity } from "./types.js";

const identity: VerifiedIdentity = {
  idp: "entra",
  idpTenant: "tenant-1",
  idpSubject: "subject-1",
  email: "ada@example.com",
  displayName: "Ada Lovelace",
  emailVerified: true,
};

describe("ClaimsProfileEnricher", () => {
  it("returns the profile from token claims", async () => {
    const enricher = new ClaimsProfileEnricher();
    const profile = await enricher.enrich(identity, "raw-token");
    expect(profile).toEqual({
      email: "ada@example.com",
      displayName: "Ada Lovelace",
      emailVerified: true,
    });
  });

  it("passes through missing profile fields as undefined", async () => {
    const enricher = new ClaimsProfileEnricher();
    const profile = await enricher.enrich(
      { idp: "entra", idpTenant: "t", idpSubject: "s" },
      "raw-token",
    );
    expect(profile).toEqual({
      email: undefined,
      displayName: undefined,
      emailVerified: undefined,
    });

  });

  it("keeps the sign-in alias distinct from an advisory email", async () => {
    const profile = await new ClaimsProfileEnricher().enrich({
      ...identity, email: "shared@example.com", alias: "ada.login@example.com", emailVerified: false,
    }, "raw-token");
    expect(profile).toMatchObject({ email: "shared@example.com", alias: "ada.login@example.com", emailVerified: false });
  });

  it("identifies itself as the claims enricher", () => {
    expect(new ClaimsProfileEnricher().id).toBe("claims");
  });
});
