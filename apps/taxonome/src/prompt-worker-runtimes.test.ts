// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, vi } from "vitest";
import { PromptWorkerRuntimes } from "./prompt-worker-runtimes.js";

function runtime(id: number) {
  let healthy = true;
  return {
    id,
    healthy: () => healthy,
    poison: () => {
      healthy = false;
    },
    close: vi.fn(async () => undefined),
  };
}

describe("prompt worker runtimes", () => {
  it("creates lazily, isolates workers, and reuses healthy runtimes", async () => {
    let next = 0;
    const created: ReturnType<typeof runtime>[] = [];
    const pool = new PromptWorkerRuntimes(async () => {
      const value = runtime(next++);
      created.push(value);
      return value;
    });

    expect(created).toHaveLength(0);
    const first = await pool.get(0);
    expect(await pool.get(0)).toBe(first);
    const second = await pool.get(1);
    expect(second).not.toBe(first);
    expect(created).toHaveLength(2);
    expect(pool.workerIds()).toEqual([0, 1]);
  });

  it("closes a poisoned runtime before the next prompt element or run", async () => {
    let next = 0;
    const created: ReturnType<typeof runtime>[] = [];
    const pool = new PromptWorkerRuntimes(async () => {
      const value = runtime(next++);
      created.push(value);
      return value;
    });
    const first = await pool.get(0);
    first.poison();
    await pool.replaceIfPoisoned(0);
    expect(first.close).toHaveBeenCalledOnce();
    const replacement = await pool.get(0);
    expect(replacement.id).toBe(1);
    expect(replacement).not.toBe(first);
    expect(await pool.get(0)).toBe(replacement);
  });

  it("aggregates independent cleanup failures", async () => {
    let next = 0;
    const pool = new PromptWorkerRuntimes(async () => {
      const value = runtime(next++);
      value.close.mockImplementation(async () => {
        throw new Error(`cleanup-${value.id}`);
      });
      return value;
    });
    await pool.get(0);
    await pool.get(1);

    const failures = await pool.closeAll();
    expect(failures.map(error => (error as Error).message)).toEqual([
      "cleanup-0",
      "cleanup-1",
    ]);
    expect(pool.workerIds()).toEqual([]);
  });
});
