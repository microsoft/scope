// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  createReadStream,
  createWriteStream,
} from "node:fs";
import {
  mkdir,
  open,
  rename,
  rm,
} from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

export interface ArchiveDownloadProgress {
  /** Bytes durably streamed into the temporary file so far. */
  downloadedBytes: number;
  /** Declared response length, when available and valid. */
  totalBytes?: number;
  /** True for the final progress event after the response stream ends. */
  complete: boolean;
}

export interface ArchiveDownloadResult {
  /** Final atomic destination path. */
  path: string;
  /** Exact compressed archive bytes downloaded. */
  bytes: number;
}

interface DownloadArchiveOptions {
  response: Response;
  outputPath: string;
  onProgress?: (progress: ArchiveDownloadProgress) => void;
  progressIntervalMs?: number;
}

function parseContentLength(response: Response): number | undefined {
  const raw = response.headers.get("content-length");
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Validates gzip framing and checksum without materializing decompressed data. */
async function verifyGzip(path: string): Promise<void> {
  const file = await open(path, "r");
  const prefix = Buffer.alloc(2);
  let bytesRead: number;
  try {
    ({ bytesRead } = await file.read(prefix, 0, prefix.length, 0));
  } finally {
    await file.close();
  }
  if (bytesRead < 2 || prefix[0] !== 0x1f || prefix[1] !== 0x8b) {
    throw new Error("Downloaded archive is not gzip data");
  }
  await pipeline(
    createReadStream(path),
    createGunzip(),
    new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  );
}

/**
 * Downloads one gzip archive atomically with progress and integrity checks.
 *
 * Bytes are streamed to an exclusive same-directory temporary file. The final
 * destination is replaced only after Content-Length (when present) and the
 * gzip trailer/checksum both validate.
 */
export async function downloadArchiveAtomic(
  options: DownloadArchiveOptions,
): Promise<ArchiveDownloadResult> {
  if (!options.response.body) {
    throw new Error("Archive response has no body");
  }

  const outputDirectory = dirname(options.outputPath);
  await mkdir(outputDirectory, { recursive: true });
  const temporaryPath = `${options.outputPath}.part-${process.pid}-${randomUUID()}`;
  const totalBytes = parseContentLength(options.response);
  const intervalMs = options.progressIntervalMs ?? 250;
  let downloadedBytes = 0;
  let lastProgressAt = 0;

  const report = (force = false) => {
    const now = Date.now();
    if (
      options.onProgress &&
      (force || now - lastProgressAt >= intervalMs)
    ) {
      lastProgressAt = now;
      options.onProgress({ downloadedBytes, totalBytes, complete: force });
    }
  };

  try {
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        downloadedBytes += chunk.length;
        report();
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(
        options.response.body as unknown as NodeReadableStream,
      ),
      counter,
      createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }),
    );
    const temporaryFile = await open(temporaryPath, "r");
    try {
      await temporaryFile.sync();
    } finally {
      await temporaryFile.close();
    }
    report(true);

    if (
      totalBytes !== undefined &&
      downloadedBytes !== totalBytes
    ) {
      throw new Error(
        `Archive download is incomplete: received ${downloadedBytes} of ${totalBytes} bytes`,
      );
    }

    try {
      await verifyGzip(temporaryPath);
    } catch (error) {
      throw new Error(
        `Downloaded archive failed gzip integrity validation: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    await rename(temporaryPath, options.outputPath);
    return { path: options.outputPath, bytes: downloadedBytes };
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

/** Formats an integer byte count using binary units. */
export function formatDownloadBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const precision = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unit]}`;
}

/** Creates one stderr progress reporter for interactive and redirected use. */
export function createArchiveProgressReporter(
  stream: NodeJS.WriteStream = process.stderr,
): (progress: ArchiveDownloadProgress) => void {
  let lastLineLength = 0;
  let lastRedirectedBytes = 0;
  return ({ downloadedBytes, totalBytes, complete }) => {
    if (
      !stream.isTTY &&
      !complete &&
      downloadedBytes - lastRedirectedBytes < 64 * 1024 * 1024
    ) {
      return;
    }
    lastRedirectedBytes = downloadedBytes;
    const downloaded = formatDownloadBytes(downloadedBytes);
    const line = totalBytes === undefined
      ? `Downloading: ${downloaded}`
      : `Downloading: ${downloaded} / ${formatDownloadBytes(totalBytes)} (${
        totalBytes === 0
          ? "100.0"
          : ((downloadedBytes / totalBytes) * 100).toFixed(1)
      }%)`;
    if (stream.isTTY) {
      stream.write(`\r${line.padEnd(lastLineLength)}`);
      lastLineLength = Math.max(lastLineLength, line.length);
      if (complete) {
        stream.write("\n");
        lastLineLength = 0;
      }
    } else {
      stream.write(`${line}\n`);
    }
  };
}
