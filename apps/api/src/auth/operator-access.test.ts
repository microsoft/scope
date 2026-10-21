// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OperatorAccessInput } from "./operator-access.js";

const script = fileURLToPath(new URL("./operator-access.ts", import.meta.url));
const target = [
  "--database", "operator-unit-fixture", "--confirm-database", "operator-unit-fixture",
  "--operator", "reviewed-operator", "--reason", "Reviewed unit fixture",
  "--idp", "entra", "--tenant", "fixture-tenant", "--subject", "fixture-subject",
  "--user-id", "aaaaaaaa-0000-4000-8000-000000000001",
];

function command(...args: string[]) {
  const env = { ...process.env };
  delete env.AUTH_OPERATOR_MONGO_URI;
  return spawnSync(process.execPath, ["--import", "tsx", script, ...args], { encoding: "utf8", env, timeout: 15_000 });
}

describe("Operator access command boundary", () => {
  it("prints all operator-only commands without database credentials", () => {
    const result = command("--help");
    expect(result.status).toBe(0);
    for (const name of ["bootstrap-admin", "set-user-access", "inspect-operation", "repair-operation"]) {
      expect(result.stdout).toContain(name);
    }
    expect(result.stdout).toContain("default to dry run");
  });

  it.each([
    { args: [], error: "Choose bootstrap-admin" },
    { args: ["bootstrap-admin", "--role", "user"], error: "does not accept role/disabled overrides" },
    { args: ["inspect-operation", "--apply"], error: "Inspection cannot apply changes" },
    { args: ["repair-operation", "--user-id", "target"], error: "user-target flags are not accepted" },
    { args: ["bootstrap-admin", "--apply", "--dry-run"], error: "mutually exclusive" },
    { args: ["bootstrap-admin", ...target, "--apply"], error: "--apply requires --revision and --operation-id" },
    { args: ["bootstrap-admin", ...target], error: "AUTH_OPERATOR_MONGO_URI is required" },
  ])("refuses invalid or unconfigured commands before connecting: $error", ({ args, error }) => {
    const result = command(...args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(error);
    expect(result.stdout).toBe("");
  });

  it("defaults validated bootstrap input to dry run and rejects arbitrary target fields", () => {
    const input = {
      database: "operator-unit-fixture", confirmDatabase: "operator-unit-fixture",
      operator: "reviewed-operator", reason: "Reviewed unit fixture",
      idp: "entra", tenant: "fixture-tenant", subject: "fixture-subject",
      userId: "aaaaaaaa-0000-4000-8000-000000000001", role: "admin", disabled: "false", bootstrap: true,
    };
    expect(OperatorAccessInput.parse(input)).toMatchObject({ apply: false });
    expect(() => OperatorAccessInput.parse({ ...input, email: "not-a-target@example.test" })).toThrow();
    expect(() => OperatorAccessInput.parse({ ...input, disabled: "true" })).toThrow(/Bootstrap can only promote/);
  });
});
