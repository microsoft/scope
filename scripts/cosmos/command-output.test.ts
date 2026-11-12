// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createWriteStream } from "node:fs";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBinaryToFiles } from "./shared.js";

vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  createWriteStream: vi.fn(),
}));

/** A slow filesystem sink makes the gap between child exit and disk completion deterministic. */
function delayedSink(chunks: Buffer[]): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      setTimeout(() => {
        chunks.push(Buffer.from(chunk));
        callback();
      }, 30);
    },
  });
}

describe("runBinaryToFiles", () => {
  afterEach(() => vi.resetAllMocks());

  it("waits for the archive and log writes after the subprocess exits", async () => {
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    const archive = delayedSink(output);
    const log = delayedSink(errors);
    vi.mocked(createWriteStream)
      .mockReturnValueOnce(archive as ReturnType<typeof createWriteStream>)
      .mockReturnValueOnce(log as ReturnType<typeof createWriteStream>);

    const code = await runBinaryToFiles({
      command: process.execPath,
      args: ["-e", "process.stdin.resume(); process.stdout.write(Buffer.from([0, 255, 42])); process.stderr.write('dump complete');"],
      input: "synthetic input",
      stdoutPath: "archive.gz",
      stderrPath: "archive.log",
    });

    expect(code).toBe(0);
    expect(archive.writableFinished).toBe(true);
    expect(log.writableFinished).toBe(true);
    expect(Buffer.concat(output)).toEqual(Buffer.from([0, 255, 42]));
    expect(Buffer.concat(errors).toString()).toBe("dump complete");
  });

  it("rejects a disk-write failure instead of reporting a successful backup", async () => {
    const diskError = new Error("synthetic disk full");
    const archive = new Writable({ write(_chunk, _encoding, callback) { callback(diskError); } });
    const log = delayedSink([]);
    vi.mocked(createWriteStream)
      .mockReturnValueOnce(archive as ReturnType<typeof createWriteStream>)
      .mockReturnValueOnce(log as ReturnType<typeof createWriteStream>);

    await expect(runBinaryToFiles({
      command: process.execPath,
      args: ["-e", "process.stdin.resume(); process.stdout.write('archive'); setInterval(() => {}, 1000);"],
      input: "synthetic input",
      stdoutPath: "archive.gz",
      stderrPath: "archive.log",
    })).rejects.toThrow(diskError);
    expect(log.writableFinished).toBe(true);
  });

  it("preserves a nonzero command status after saving its diagnostics", async () => {
    const errors: Buffer[] = [];
    vi.mocked(createWriteStream)
      .mockReturnValueOnce(delayedSink([]) as ReturnType<typeof createWriteStream>)
      .mockReturnValueOnce(delayedSink(errors) as ReturnType<typeof createWriteStream>);

    expect(await runBinaryToFiles({
      command: process.execPath,
      args: ["-e", "process.stdin.resume(); process.stderr.write('failure'); process.exitCode = 7;"],
      input: "synthetic input",
      stdoutPath: "archive.gz",
      stderrPath: "archive.log",
    })).toBe(7);
    expect(Buffer.concat(errors).toString()).toBe("failure");
  });

  it("returns failure and saves the error when the command cannot start", async () => {
    const errors: Buffer[] = [];
    vi.mocked(createWriteStream)
      .mockReturnValueOnce(delayedSink([]) as ReturnType<typeof createWriteStream>)
      .mockReturnValueOnce(delayedSink(errors) as ReturnType<typeof createWriteStream>);

    expect(await runBinaryToFiles({
      command: "scope-test-command-that-does-not-exist",
      args: [],
      input: "synthetic input",
      stdoutPath: "archive.gz",
      stderrPath: "archive.log",
    })).toBe(1);
    expect(Buffer.concat(errors).toString()).toContain("ENOENT");
  });
});
