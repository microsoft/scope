// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Codebase archive helpers.
 *
 * Both source types (git tarball download, user upload) are normalized to a
 * single canonical form: a gzipped tar whose entries live at the archive root
 * (no wrapper directory). This lets the worker seeder extract every codebase
 * revision the same way — straight into the workspace root, with no
 * `--strip-components` guesswork.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve, sep } from "path";

/** Result of normalizing an archive to a root-level tar.gz. */
export interface NormalizedArchive {
  /** The normalized tar.gz bytes (entries at root). */
  data: Buffer;
  /** Number of files (not directories) in the snapshot. */
  fileCount: number;
  /** Size of the normalized archive in bytes. */
  sizeBytes: number;
}

/**
 * Bounds applied while extracting an untrusted archive, guarding against
 * decompression bombs (a tiny compressed input that inflates to many GB).
 *
 * The 1 MB ingress cap enforced at the edge applies to *compressed* bytes, so
 * it does not bound the inflated size — these limits do.
 */
export interface ExtractLimits {
  /** Maximum total uncompressed bytes written across all entries. */
  maxBytes: number;
  /** Maximum number of entries (files + directories) extracted. */
  maxEntries: number;
}

/** Thrown when an archive exceeds its {@link ExtractLimits} during extraction. */
export class ArchiveTooLargeError extends Error {
  readonly code = "ARCHIVE_TOO_LARGE";
  constructor(message: string) {
    super(message);
    this.name = "ArchiveTooLargeError";
  }
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Default extraction limits, overridable via environment variables:
 * - `CODEBASE_MAX_EXTRACTED_BYTES` (default 256 MiB)
 * - `CODEBASE_MAX_EXTRACTED_ENTRIES` (default 50,000)
 */
export const DEFAULT_EXTRACT_LIMITS: ExtractLimits = {
  maxBytes: envInt("CODEBASE_MAX_EXTRACTED_BYTES", 256 * 1024 * 1024),
  maxEntries: envInt("CODEBASE_MAX_EXTRACTED_ENTRIES", 50_000),
};

function detectFormat(buffer: Buffer): "gzip" | "zip" | "tar" | "unknown" {
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) return "gzip";
  if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) return "zip";
  // tar "ustar" magic lives at offset 257
  if (buffer.length >= 262 && buffer.toString("ascii", 257, 262) === "ustar") return "tar";
  return "unknown";
}

function countFiles(dir: string): number {
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "." || entry.name === "..") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      count += countFiles(full);
    } else {
      count += 1;
    }
  }
  return count;
}

/**
 * Resolve a zip entry's path inside `destDir`, guarding against Zip Slip.
 * Rejects absolute paths and any `..` traversal that would escape `destDir`.
 *
 * Exported for unit testing.
 */
export function resolveSafeEntryPath(destDir: string, entryName: string): string {
  // Normalize separators; zip entries use forward slashes by spec.
  const normalized = entryName.split("/").join(sep);
  const target = resolve(destDir, normalized);
  const root = resolve(destDir);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`Refusing to extract zip entry outside target directory: '${entryName}'`);
  }
  return target;
}

/**
 * Tar extraction filter that guards against path-traversal and symlink escape.
 *
 * `node-tar` v7 already strips `..` and refuses to write through symlinks, but
 * this makes the protection explicit and symmetric with the zip path: it rejects
 * any entry — or any sym/hard-link target — that would resolve outside `destDir`.
 *
 * Throws on violation. NOTE: this must NOT be thrown directly from a `tar.extract`
 * `filter` callback — node-tar surfaces a thrown filter error as an *uncaught*
 * exception from the parser rather than rejecting the extract promise, which would
 * crash the process. `extractArchiveBuffer` therefore calls this inside a
 * try/catch, captures the violation, skips the entry, and rethrows after extraction
 * completes. Exported for unit testing.
 */
export function assertTarEntrySafe(destDir: string, entryPath: string, linkpath?: string): boolean {
  const root = resolve(destDir);
  const within = (p: string) => p === root || p.startsWith(root + sep);

  const target = resolve(destDir, entryPath);
  if (!within(target)) {
    throw new Error(`Refusing to extract tar entry outside target directory: '${entryPath}'`);
  }
  if (linkpath) {
    // Link targets are resolved relative to the entry's own directory.
    const linkTarget = resolve(dirname(target), linkpath);
    if (!within(linkTarget)) {
      throw new Error(
        `Refusing to extract tar link escaping target directory: '${entryPath}' -> '${linkpath}'`
      );
    }
  }
  return true;
}

/**
 * Safely extract a zip buffer into `destDir` using yauzl (no shell-out).
 * Every entry path is validated to stay within `destDir` before any write, and
 * the cumulative entry count and uncompressed byte total are bounded by `limits`.
 */
async function extractZipBuffer(
  buffer: Buffer,
  destDir: string,
  limits: ExtractLimits
): Promise<void> {
  const yauzl = await import("yauzl");
  const { createWriteStream, mkdirSync } = await import("fs");

  await new Promise<void>((resolvePromise, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(err ?? new Error("Failed to open zip archive"));
        return;
      }

      const fail = (e: unknown) => {
        zipfile.close();
        reject(e instanceof Error ? e : new Error(String(e)));
      };

      let entryCount = 0;
      let totalBytes = 0;

      zipfile.on("error", fail);
      zipfile.on("end", () => resolvePromise());

      zipfile.on("entry", (entry) => {
        try {
          entryCount += 1;
          if (entryCount > limits.maxEntries) {
            fail(
              new ArchiveTooLargeError(
                `Archive exceeds the maximum entry count (${limits.maxEntries})`
              )
            );
            return;
          }
          const target = resolveSafeEntryPath(destDir, entry.fileName);
          if (entry.fileName.endsWith("/")) {
            // Directory entry.
            mkdirSync(target, { recursive: true });
            zipfile.readEntry();
            return;
          }
          // Fast pre-reject using the (untrusted) central-directory size.
          if (totalBytes + (entry.uncompressedSize ?? 0) > limits.maxBytes) {
            fail(
              new ArchiveTooLargeError(
                `Archive exceeds the maximum uncompressed size (${limits.maxBytes} bytes)`
              )
            );
            return;
          }
          mkdirSync(dirname(target), { recursive: true });
          zipfile.openReadStream(entry, (streamErr, readStream) => {
            if (streamErr || !readStream) {
              fail(streamErr ?? new Error("Failed to read zip entry"));
              return;
            }
            const out = createWriteStream(target);
            // Defense-in-depth: count the bytes we actually inflate, in case the
            // central-directory header lied about the uncompressed size.
            readStream.on("data", (chunk: Buffer) => {
              totalBytes += chunk.length;
              if (totalBytes > limits.maxBytes) {
                readStream.destroy();
                out.destroy();
                fail(
                  new ArchiveTooLargeError(
                    `Archive exceeds the maximum uncompressed size (${limits.maxBytes} bytes)`
                  )
                );
              }
            });
            readStream.on("error", fail);
            out.on("error", fail);
            out.on("close", () => zipfile.readEntry());
            readStream.pipe(out);
          });
        } catch (entryErr) {
          fail(entryErr);
        }
      });

      zipfile.readEntry();
    });
  });
}

/**
 * Extract an archive buffer (tar.gz, tar, or zip) into `destDir`.
 * Detects the format from magic bytes. Extraction is bounded by `limits` to
 * guard against decompression bombs.
 */
export async function extractArchiveBuffer(
  buffer: Buffer,
  destDir: string,
  limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS
): Promise<void> {
  const format = detectFormat(buffer);
  if (format === "zip") {
    await extractZipBuffer(buffer, destDir, limits);
    return;
  }
  // tar.gz / tar — the `tar` lib auto-detects gzip.
  const tar = await import("tar");
  const { writeFileSync, rmSync: rmDir } = await import("fs");
  const tmp = mkdtempSync(join(tmpdir(), "codebase-tar-"));
  const tarPath = join(tmp, "archive.tar");
  writeFileSync(tarPath, buffer);

  // A thrown error inside node-tar's `filter` surfaces as an uncaught exception
  // rather than rejecting the extract promise, so we capture the first violation,
  // skip the offending entry, and rethrow after extraction settles.
  let violation: Error | undefined;
  let entryCount = 0;
  let totalBytes = 0;

  try {
    await tar.extract({
      file: tarPath,
      cwd: destDir,
      filter: (path, entry) => {
        if (violation) return false;
        entryCount += 1;
        if (entryCount > limits.maxEntries) {
          violation = new ArchiveTooLargeError(
            `Archive exceeds the maximum entry count (${limits.maxEntries})`
          );
          return false;
        }
        totalBytes += (entry as { size?: number }).size ?? 0;
        if (totalBytes > limits.maxBytes) {
          violation = new ArchiveTooLargeError(
            `Archive exceeds the maximum uncompressed size (${limits.maxBytes} bytes)`
          );
          return false;
        }
        try {
          // Defense-in-depth: reject any entry or link target that escapes destDir.
          return assertTarEntrySafe(destDir, path, (entry as { linkpath?: string }).linkpath);
        } catch (err) {
          violation = err instanceof Error ? err : new Error(String(err));
          return false;
        }
      },
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  if (violation) {
    // Discard whatever was written before the violation was detected.
    rmDir(destDir, { recursive: true, force: true });
    throw violation;
  }
}

/**
 * Normalize an arbitrary archive buffer to a root-level tar.gz.
 *
 * Extracts the input, unwraps a single top-level directory if present
 * (e.g. GitHub tarballs are wrapped in `{owner}-{repo}-{sha}/`), then re-archives
 * the contents at the root.
 */
export async function normalizeToRootTarGz(
  buffer: Buffer,
  limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS
): Promise<NormalizedArchive> {
  const tar = await import("tar");
  const workDir = mkdtempSync(join(tmpdir(), "codebase-normalize-"));
  const extractDir = join(workDir, "extracted");
  const { mkdirSync } = await import("fs");
  mkdirSync(extractDir, { recursive: true });

  try {
    await extractArchiveBuffer(buffer, extractDir, limits);

    // Unwrap a single top-level directory.
    const entries = readdirSync(extractDir, { withFileTypes: true }).filter(
      (e) => e.name !== "." && e.name !== ".."
    );
    let rootDir = extractDir;
    if (entries.length === 1 && entries[0].isDirectory()) {
      rootDir = join(extractDir, entries[0].name);
    }

    const fileCount = countFiles(rootDir);

    // Archive the directory itself (`.`) so hidden files and folders
    // (.env, .github, .gitignore) stay in the snapshot. Passing an
    // explicit readdir list is easy to get wrong on some platforms.
    const outPath = join(workDir, "normalized.tar.gz");
    await tar.create({ gzip: true, file: outPath, cwd: rootDir }, ["."]);

    const data = readFileSync(outPath);
    return { data, fileCount, sizeBytes: statSync(outPath).size };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
