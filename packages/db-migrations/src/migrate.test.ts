// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { REQUIRED_MIGRATIONS } from "./required-migrations.js";

const mocks = vi.hoisted(() => ({
  cli: vi.fn(),
  createIndex: vi.fn().mockResolvedValue("index"),
  close: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("mongo-migrate-ts", () => ({ mongoMigrateCli: mocks.cli }));
vi.mock("mongodb", () => ({
  MongoClient: {
    connect: vi.fn().mockResolvedValue({
      db: () => ({ collection: () => ({ createIndex: mocks.createIndex }) }),
      close: mocks.close,
    }),
  },
}));

describe("migration CLI discovery", () => {
  it("discovers the RBAC migrations without executing the deferred codebase change", async () => {
    await import("./migrate.js");

    expect(mocks.cli).toHaveBeenCalledOnce();
    const config = mocks.cli.mock.calls[0][0] as {
      migrationsDir: string;
      globPattern: string;
    };
    expect(config.globPattern).toBe("**/*.ts");
    expect(config.migrationsDir).toBe(join(import.meta.dirname, "migrations"));
    const discovered = readdirSync(config.migrationsDir, { recursive: true })
      .filter((file): file is string => typeof file === "string" && file.endsWith(".ts"))
      .sort();
    expect(discovered).toEqual([...REQUIRED_MIGRATIONS].sort());
    expect(discovered).toContain("029-create-users-collection.ts");
    expect(discovered).toContain("031-create-project-memberships.ts");
    expect(discovered).not.toContain("032-scope-codebase-uniqueness.ts");
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
