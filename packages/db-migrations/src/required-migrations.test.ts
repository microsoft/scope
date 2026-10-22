// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { REQUIRED_MIGRATIONS } from "./required-migrations.js";
import { readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("REQUIRED_MIGRATIONS", () => {
  it("is a non-empty array", () => {
    expect(REQUIRED_MIGRATIONS.length).toBeGreaterThan(0);
  });

  it("lists only .ts files", () => {
    for (const file of REQUIRED_MIGRATIONS) {
      expect(file).toMatch(/\.ts$/);
    }
  });

  it("requires identity and membership authority, not the deferred codebase index migration", () => {
    expect(REQUIRED_MIGRATIONS).toContain("029-create-users-collection.ts");
    expect(REQUIRED_MIGRATIONS).toContain("031-create-project-memberships.ts");
    expect(REQUIRED_MIGRATIONS).not.toContain("032-scope-codebase-uniqueness.ts");
  });

  it("matches actual migration files on disk", () => {
    const migrationsDir = join(__dirname, "migrations");
    const filesOnDisk = readdirSync(migrationsDir).filter((f) =>
      f.endsWith(".ts") && !f.endsWith(".test.ts"),
    );
    for (const required of REQUIRED_MIGRATIONS) {
      expect(filesOnDisk).toContain(required);
    }
  });

  it("includes all migration files on disk", () => {
    const migrationsDir = join(__dirname, "migrations");
    const filesOnDisk = readdirSync(migrationsDir).filter((f) =>
      f.endsWith(".ts") && !f.endsWith(".test.ts"),
    );
    for (const file of filesOnDisk) {
      expect(REQUIRED_MIGRATIONS).toContain(file);
    }
  });
});
