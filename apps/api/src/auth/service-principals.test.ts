// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "shared";
import { SERVICE_PRINCIPALS, createServiceKeyVerifier } from "./service-principals.js";

const REGISTER_KEY = "r".repeat(40);
const SCANNER_KEY = "s".repeat(40);
const env = {
  INTERNAL_API_KEY_REGISTER_AGENTS: REGISTER_KEY,
  INTERNAL_API_KEY_MODEL_SCANNER: SCANNER_KEY,
};

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AuthError);
    return (err as AuthError).code;
  }
  throw new Error("expected rejection");
}

describe("createServiceKeyVerifier", () => {
  afterEach(() => vi.restoreAllMocks());

  it("identifies each service with its own key and scopes", () => {
    const verify = createServiceKeyVerifier(env);
    expect(verify("register-agents", REGISTER_KEY)).toEqual({
      name: "register-agents",
      scopes: ["agents:register"],
    });
    expect(verify("model-scanner", SCANNER_KEY)).toEqual({
      name: "model-scanner",
      scopes: ["agents:read", "agents:register", "models:sync"],
    });
  });

  it("rejects a wrong key, another service's key, and unknown services", () => {
    const verify = createServiceKeyVerifier(env);
    expect(codeOf(() => verify("register-agents", "x".repeat(40)))).toBe("invalid_service_key");
    expect(codeOf(() => verify("register-agents", SCANNER_KEY))).toBe("invalid_service_key");
    expect(codeOf(() => verify("someone-else", REGISTER_KEY))).toBe("invalid_service_key");
  });

  it("fails closed when a service's key is not configured", () => {
    const verify = createServiceKeyVerifier({});
    for (const def of SERVICE_PRINCIPALS) {
      expect(codeOf(() => verify(def.name, ""))).toBe("invalid_service_key");
    }
  });

  it("disables a service whose configured key is too short", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const verify = createServiceKeyVerifier({ INTERNAL_API_KEY_REGISTER_AGENTS: "short" });
    expect(codeOf(() => verify("register-agents", "short"))).toBe("invalid_service_key");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("INTERNAL_API_KEY_REGISTER_AGENTS"));
  });
});
