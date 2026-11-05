// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  createArchiveProgressReporter,
  downloadArchiveAtomic,
  formatDownloadBytes,
  type ArchiveDownloadProgress,
} from "./archive-download.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function directory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "scope-archive-download-"));
  directories.push(value);
  return value;
}

function archiveResponse(
  bytes: Uint8Array,
  contentLength = bytes.length,
): Response {
  const body = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/gzip",
      "Content-Length": String(contentLength),
    },
  });
}

describe("atomic archive download", () => {
  it("reports progress, validates gzip, and atomically replaces the destination", async () => {
    const root = await directory();
    const outputPath = join(root, "batch.tar.gz");
    await writeFile(outputPath, "old archive");
    const bytes = gzipSync(Buffer.from("validated archive contents"));
    const progress: ArchiveDownloadProgress[] = [];

    await expect(downloadArchiveAtomic({
      response: archiveResponse(bytes),
      outputPath,
      progressIntervalMs: 0,
      onProgress: event => progress.push(event),
    })).resolves.toEqual({
      path: outputPath,
      bytes: bytes.length,
    });

    expect(await readFile(outputPath)).toEqual(bytes);
    expect(progress.at(-1)).toEqual({
      downloadedBytes: bytes.length,
      totalBytes: bytes.length,
      complete: true,
    });
    expect((await readdir(root)).filter(name => name.includes(".part-")))
      .toEqual([]);
  });

  it("preserves an existing destination and removes temp files on length mismatch", async () => {
    const root = await directory();
    const outputPath = join(root, "batch.tar.gz");
    await writeFile(outputPath, "known-good");
    const bytes = gzipSync(Buffer.from("truncated response"));

    await expect(downloadArchiveAtomic({
      response: archiveResponse(bytes, bytes.length + 100),
      outputPath,
    })).rejects.toThrow(
      `received ${bytes.length} of ${bytes.length + 100} bytes`,
    );
    expect(await readFile(outputPath, "utf8")).toBe("known-good");
    expect((await readdir(root)).filter(name => name.includes(".part-")))
      .toEqual([]);
  });

  it.each([
    ["non-gzip", Buffer.from("not gzip"), /not gzip data/],
    [
      "truncated gzip",
      gzipSync(Buffer.from("integrity checked")).subarray(0, -4),
      /gzip integrity validation/,
    ],
  ])("rejects %s without publishing it", async (_name, bytes, expected) => {
    const root = await directory();
    const outputPath = join(root, "batch.tar.gz");

    await expect(downloadArchiveAtomic({
      response: archiveResponse(bytes),
      outputPath,
    })).rejects.toThrow(expected);
    await expect(readFile(outputPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await readdir(root)).filter(name => name.includes(".part-")))
      .toEqual([]);
  });

  it("formats byte progress for redirected and TTY streams", () => {
    expect(formatDownloadBytes(1024 ** 3 * 6.64))
      .toBe("6.64 GiB");

    let redirected = "";
    const redirectedStream = {
      isTTY: false,
      write: (text: string) => {
        redirected += text;
        return true;
      },
    } as NodeJS.WriteStream;
    createArchiveProgressReporter(redirectedStream)({
      downloadedBytes: 512,
      totalBytes: 1024,
      complete: true,
    });
    expect(redirected).toContain("Downloading: 512 B / 1.00 KiB (50.0%)\n");

    let tty = "";
    const ttyStream = {
      isTTY: true,
      write: (text: string) => {
        tty += text;
        return true;
      },
    } as NodeJS.WriteStream;
    const report = createArchiveProgressReporter(ttyStream);
    report({ downloadedBytes: 1, complete: false });
    report({ downloadedBytes: 2, complete: true });
    expect(tty).toContain("\rDownloading:");
    expect(tty.endsWith("\n")).toBe(true);
  });
});
