// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createReadStream } from "node:fs";
import {
  realpath,
  stat,
} from "node:fs/promises";
import {
  isAbsolute,
  resolve,
} from "node:path";
import type { Readable } from "node:stream";

/** One literal path selected by a path-list record. */
export interface RunInputSelection {
  /** One-based nonempty record number in the path list. */
  record: number;
  /** Exact decoded record text, without its delimiter. */
  original: string;
  /** Absolute CWD-relative filesystem path. */
  resolved: string;
  /** Canonical existing file path, or stable lexical path on selection error. */
  canonical: string;
  /** Per-input selection failure; valid inputs continue in batch mode. */
  error?: Error;
}

export interface ReadRunInputOptions {
  /** Use NUL records rather than LF/CRLF records. */
  nullDelimited?: boolean;
  /** CWD used for every relative record, including disk-list records. */
  cwd?: string;
  /** Cancellation signal checked during list framing and path resolution. */
  signal?: AbortSignal;
  /** Injectable stdin for tests; production defaults to process.stdin. */
  stdin?: Readable;
}

/** Reads and resolves one literal path list before any runtime starts. */
export async function readRunInputSelections(
  listSource: string,
  options: ReadRunInputOptions = {},
): Promise<RunInputSelection[]> {
  const cwd = options.cwd ?? process.cwd();
  const stream = listSource === "-"
    ? options.stdin ?? process.stdin
    : createReadStream(
      isAbsolute(listSource) ? listSource : resolve(cwd, listSource),
    );
  const records = await parseRunInputRecords(
    stream,
    options.nullDelimited ?? false,
    listSource,
    options.signal,
  );
  const selections: RunInputSelection[] = [];
  const seen = new Set<string>();

  for (const [index, original] of records.entries()) {
    throwIfAborted(options.signal);
    const resolved = isAbsolute(original) ? original : resolve(cwd, original);
    let canonical = resolved;
    let error: Error | undefined;
    try {
      const details = await stat(resolved);
      if (!details.isFile()) {
        error = new Error(`Listed input is not a regular file: ${original}`);
      } else {
        canonical = await realpath(resolved);
      }
    } catch (cause) {
      error = new Error(`Listed input is unavailable: ${original}`, {
        cause,
      });
    }

    if (seen.has(canonical)) continue;
    seen.add(canonical);
    selections.push({
      record: index + 1,
      original,
      resolved,
      canonical,
      ...(error ? { error } : {}),
    });
  }
  return selections;
}

/** Incrementally frames strict UTF-8 LF/CRLF or NUL path records. */
export async function parseRunInputRecords(
  input: AsyncIterable<Uint8Array | string>,
  nullDelimited: boolean,
  sourceLabel = "<stdin>",
  signal?: AbortSignal,
): Promise<string[]> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const delimiter = nullDelimited ? "\0" : "\n";
  const records: string[] = [];
  let pending = "";
  let endedWithDelimiter = false;
  const destroyable = input as AsyncIterable<Uint8Array | string> & {
    destroyed?: boolean;
    destroy?(error?: Error): void;
  };
  const onAbort = () => {
    destroyable.destroy?.(new Error("Path-list reading was cancelled"));
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    for await (const chunk of input) {
      throwIfAborted(signal);
      pending += typeof chunk === "string"
        ? chunk
        : decoder.decode(chunk, { stream: true });
      while (true) {
        const index = pending.indexOf(delimiter);
        if (index < 0) break;
        const raw = pending.slice(0, index);
        pending = pending.slice(index + delimiter.length);
        const record = !nullDelimited && raw.endsWith("\r")
          ? raw.slice(0, -1)
          : raw;
        if (!record.length) {
          throw listError(
            sourceLabel,
            records.length + 1,
            "empty interior path record",
          );
        }
        records.push(record);
        endedWithDelimiter = true;
      }
      if (pending.length) endedWithDelimiter = false;
    }
    pending += decoder.decode();
  } catch (error) {
    if (!destroyable.destroyed) destroyable.destroy?.();
    if (signal?.aborted) throw new Error("Path-list reading was cancelled");
    if (error instanceof TypeError) {
      throw new Error(`Path list '${sourceLabel}' is not valid UTF-8`);
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }

  if (pending.length) {
    const record = !nullDelimited && pending.endsWith("\r")
      ? pending.slice(0, -1)
      : pending;
    if (!record.length) {
      throw listError(
        sourceLabel,
        records.length + 1,
        "empty final path record",
      );
    }
    records.push(record);
  } else if (!records.length || !endedWithDelimiter) {
    throw new Error(`Path list '${sourceLabel}' contains no paths`);
  }
  return records;
}

function listError(
  source: string,
  record: number,
  message: string,
): Error {
  return new Error(`Path list '${source}' record ${record}: ${message}`);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Path-list reading was cancelled");
}
