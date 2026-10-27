// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi } from "vitest";
import type { Db } from "mongodb";

const { RemoveExtensionsFeatureFlag } = await import(
  "./migrations/031-remove-extensions-feature-flag.js"
);

function makeMockDb(deletedCount = 1) {
  const flags = {
    deleteMany: vi.fn().mockResolvedValue({ deletedCount }),
    updateOne: vi.fn().mockResolvedValue({ upsertedCount: 1 }),
  };
  const db = {
    collection: vi.fn((name: string) => {
      if (name === "feature-flags") return flags;
      throw new Error(`unexpected collection ${name}`);
    }),
  } as unknown as Db;
  return { db, flags };
}

describe("migration 031: RemoveExtensionsFeatureFlag", () => {
  it("up() deletes only the extensions flag", async () => {
    const { db, flags } = makeMockDb();

    await new RemoveExtensionsFeatureFlag().up(db);

    expect(flags.deleteMany).toHaveBeenCalledTimes(1);
    expect(flags.deleteMany).toHaveBeenCalledWith({ key: "extensions" });
    expect(flags.updateOne).not.toHaveBeenCalled();
  });

  it("up() is idempotent when the flag is already gone", async () => {
    const { db } = makeMockDb(0);

    await expect(new RemoveExtensionsFeatureFlag().up(db)).resolves.toBeUndefined();
  });

  it("down() restores the enabled flag without overwriting an existing one", async () => {
    const { db, flags } = makeMockDb();

    await new RemoveExtensionsFeatureFlag().down(db);

    expect(flags.updateOne).toHaveBeenCalledWith(
      { key: "extensions" },
      {
        $setOnInsert: expect.objectContaining({
          key: "extensions",
          label: "VS Code Extensions",
          enabled: true,
        }),
      },
      { upsert: true },
    );
    expect(flags.deleteMany).not.toHaveBeenCalled();
  });
});
