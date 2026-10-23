// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash, timingSafeEqual } from "node:crypto";
import { AuthError } from "shared";

/** Header carrying the calling service's name. */
export const SERVICE_NAME_HEADER = "x-service-name";
/** Header carrying the calling service's shared key. */
export const SERVICE_KEY_HEADER = "x-internal-key";

/** Minimum accepted key length; shorter configured keys disable the service. */
export const MIN_SERVICE_KEY_LENGTH = 32;

/** Static definition of an internal service caller. */
export interface ServicePrincipalDefinition {
  /** Value expected in `X-Service-Name`. */
  name: string;
  /** API env var holding this service's key. */
  keyEnv: string;
  /**
   * Scopes granted to this service. Authorization maps each scope to the
   * routes it allows (`SERVICE_SCOPE_ROUTES` in `authorization.ts`).
   */
  scopes: readonly string[];
}

/** Known internal services. Each has its own key; there is no shared key. */
export const SERVICE_PRINCIPALS: readonly ServicePrincipalDefinition[] = Object.freeze([
  { name: "register-agents", keyEnv: "INTERNAL_API_KEY_REGISTER_AGENTS", scopes: ["agents:register"] },
  {
    name: "model-scanner",
    keyEnv: "INTERNAL_API_KEY_MODEL_SCANNER",
    scopes: ["agents:read", "agents:register", "models:sync"],
  },
]);

/** Verified service caller. */
export interface VerifiedService {
  name: string;
  scopes: readonly string[];
}

/** Verifies a service name/key pair, throwing {@link AuthError} when rejected. */
export type ServiceKeyVerifier = (name: string, key: string) => VerifiedService;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf-8").digest();
}

/**
 * Build a verifier from env. Services whose key is missing or shorter than
 * {@link MIN_SERVICE_KEY_LENGTH} are disabled (fail closed).
 */
export function createServiceKeyVerifier(
  env: NodeJS.ProcessEnv = process.env,
  definitions: readonly ServicePrincipalDefinition[] = SERVICE_PRINCIPALS,
): ServiceKeyVerifier {
  const keys = new Map<string, { digest: Buffer; scopes: readonly string[] }>();
  for (const def of definitions) {
    const key = env[def.keyEnv];
    if (!key) continue;
    if (key.length < MIN_SERVICE_KEY_LENGTH) {
      console.warn(`[auth] ${def.keyEnv} is shorter than ${MIN_SERVICE_KEY_LENGTH} characters; service "${def.name}" is disabled`);
      continue;
    }
    keys.set(def.name, { digest: digest(key), scopes: def.scopes });
  }

  return (name, key) => {
    const entry = keys.get(name);
    // Always hash the presented key so unknown and known services take similar time.
    const presented = digest(key);
    if (!entry || !timingSafeEqual(entry.digest, presented)) {
      throw new AuthError("invalid_service_key", "Invalid service credentials");
    }
    return { name, scopes: entry.scopes };
  };
}
