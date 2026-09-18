// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ProfileEnricher, UserProfile, VerifiedIdentity } from "./types.js";

/**
 * Default {@link ProfileEnricher}: returns the profile straight from the
 * verified token claims. No network call and no client secret required.
 *
 * A future `GraphProfileEnricher` would implement the same interface using the
 * On-Behalf-Of flow to call Microsoft Graph `/me`, and would be selected via
 * configuration without changing any call site.
 */
export class ClaimsProfileEnricher implements ProfileEnricher {
  readonly id = "claims";

  async enrich(
    identity: VerifiedIdentity,
    _rawToken: string,
  ): Promise<UserProfile> {
    return {
      email: identity.email,
      displayName: identity.displayName,
      emailVerified: identity.emailVerified,
    };
  }
}
