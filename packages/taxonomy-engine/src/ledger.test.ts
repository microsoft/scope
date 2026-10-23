// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CallLedger } from "./ledger.js";

const dirs: string[] = [];

// Ledger tests allocate real lock files; remove each owned directory after the test.
afterEach(async () => {
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});
describe("durable all-in budget", () => {
  it("stops before call 501 across fresh instances; failures and unfinished reservations count", async () => {
    // A fresh instance per reservation proves usage cannot reset across processes/commands.
    const dir = await mkdtemp(join(tmpdir(), "taxonome-ledger-test-"));
    dirs.push(dir);
    const path = join(dir, "calls.jsonl");
    const first = new CallLedger(path);
    await first.initialize();
    for (let i = 1; i <= 500; i++) expect(await new CallLedger(path).reserve("mock", i % 2 ? "student" : "teacher")).toBe(i);
    await first.finish(1, false, 1, null, null);
    await expect(first.finish(1, false, 1, null, null)).rejects.toThrow("unfinished reservation");
    await expect(first.initialize(501)).rejects.toThrow();
    const restarted = new CallLedger(path);
    await restarted.initialize();
    await expect(restarted.reserve("mock", "retry/replay")).rejects.toThrow("500/500");
    await expect(restarted.initialize(499)).rejects.toThrow("cannot be reset");
    expect((await restarted.summary()).used).toBe(500);
  },
    15_000
  );
  it("does not race concurrent processes/instances or permit a missing ledger", async () => {
    // Two contenders race for one slot; the lock must admit exactly one reservation.
    const dir = await mkdtemp(join(tmpdir(), "taxonome-ledger-test-"));
    dirs.push(dir);
    const a = new CallLedger(join(dir, "calls.jsonl"));
    await expect(a.reserve("mock", "missing")).rejects.toThrow();
    await a.initialize(1);
    const attempts = await Promise.allSettled([a.reserve("mock", "a"), new CallLedger(a.path).reserve("mock", "b")]);
    expect(attempts.filter(a => a.status === "fulfilled")).toHaveLength(1);
    expect((await a.summary()).used).toBe(1);
  });
});
