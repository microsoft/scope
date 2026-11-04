// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { extractPort } from "./open-portal.js";

describe("extractPort", () => {
  it("extracts PORTAL_PORT from a standard .env content", () => {
    const env = `
API_PORT=3100
PORTAL_PORT=5100
REDIS_PORT=6300
`;
    expect(extractPort(env, "PORTAL_PORT")).toBe(5100);
  });

  it("extracts a worktree-offset port", () => {
    const env = `
# --- BEGIN managed by worktree-env.sh (do not edit) ---
# Worktree: my-feature  |  Offset: 3
COMPOSE_PROJECT_NAME=scope-mt-app-my-feature
API_PORT=3103
PORTAL_PORT=5103
REDIS_PORT=6303
# --- END managed by worktree-env.sh ---
`;
    expect(extractPort(env, "PORTAL_PORT")).toBe(5103);
  });

  it("returns undefined when the key is not present", () => {
    const env = `
API_PORT=3100
REDIS_PORT=6300
`;
    expect(extractPort(env, "PORTAL_PORT")).toBeUndefined();
  });

  it("returns undefined for non-numeric value", () => {
    const env = `PORTAL_PORT=not-a-number`;
    expect(extractPort(env, "PORTAL_PORT")).toBeUndefined();
  });

  it("ignores commented-out lines", () => {
    const env = `
# PORTAL_PORT=9999
PORTAL_PORT=5100
`;
    expect(extractPort(env, "PORTAL_PORT")).toBe(5100);
  });

  it("returns the last occurrence when duplicated", () => {
    const env = `
PORTAL_PORT=5100
PORTAL_PORT=5103
`;
    expect(extractPort(env, "PORTAL_PORT")).toBe(5103);
  });

  it.each([
    'PORTAL_PORT="5103"',
    "PORTAL_PORT='5103'",
    "export PORTAL_PORT=5103 # managed worktree port",
  ])("parses dotenv assignment %s", (env) => {
    expect(extractPort(env, "PORTAL_PORT")).toBe(5103);
  });

  it.each(["0", "-1", "65536", "5103oops", "5103.5", "1e3", ""])(
    "rejects invalid port %s",
    (value) => expect(extractPort(`PORTAL_PORT=${value}`, "PORTAL_PORT")).toBeUndefined(),
  );

  it("accepts both ends of the TCP port range", () => {
    expect(extractPort("PORTAL_PORT=1", "PORTAL_PORT")).toBe(1);
    expect(extractPort("PORTAL_PORT=65535", "PORTAL_PORT")).toBe(65535);
  });

  it("does not fall back to an earlier assignment when the final one is invalid", () => {
    expect(extractPort("PORTAL_PORT=5100\nPORTAL_PORT=invalid", "PORTAL_PORT")).toBeUndefined();
  });

  it("handles empty content", () => {
    expect(extractPort("", "PORTAL_PORT")).toBeUndefined();
  });

  it("handles lines without equals sign", () => {
    const env = `
PORTAL_PORT
API_PORT=3100
`;
    expect(extractPort(env, "PORTAL_PORT")).toBeUndefined();
    expect(extractPort(env, "API_PORT")).toBe(3100);
  });
});
