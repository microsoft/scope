// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { open } from "node:fs/promises";

const MAX_BYTES = 2 * 1024 * 1024;
const TRANSIENT = new Set([429, 500, 502, 503, 504]);

/** Carries retry metadata for HTTP responses without exposing the requested URL. */
class HttpFailure extends Error {
  /**
   * @param status - HTTP status code returned by the ATIF endpoint.
   * @param retryAfter - Raw Retry-After header, or null when absent.
   */
  constructor(readonly status: number, readonly retryAfter: string | null) {
    super(`ATIF download failed: HTTP ${status}`);
  }
}

/**
 * Performs one complete bounded fetch, including redirects and streamed body reads.
 *
 * @param location - Absolute HTTP(S) URL without userinfo credentials.
 * @param byteLimit - Maximum response body size in bytes.
 * @param timeoutMs - Deadline in milliseconds covering redirects and body reads.
 * @returns UTF-8 response text.
 */
async function downloadAttempt(location: string, byteLimit: number, timeoutMs: number): Promise<Buffer> {
  let url = new URL(location);
  if (url.username || url.password) {
    throw new Error("ATIF URL userinfo is not supported");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // The same deadline covers redirects and body reads, not just response headers.
  try {
    let response: Response;
    for (let redirects = 0; ; redirects++) {
      response = await fetch(url, { redirect: "manual", signal: controller.signal, headers: { Accept: "application/json" } });
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        break;
      }

      await response.body?.cancel();
      if (redirects >= 3) {
        throw new Error("ATIF redirect limit exceeded");
      }

      const target = response.headers.get("location");
      if (!target) {
        throw new Error("ATIF redirect is missing Location");
      }

      const nextUrl = new URL(target, url);
      if (
        !["http:", "https:"].includes(nextUrl.protocol) ||
        nextUrl.username ||
        nextUrl.password ||
        (url.protocol === "https:" && nextUrl.protocol !== "https:")
      ) {
        throw new Error("Unsafe ATIF redirect");
      }
      url = nextUrl;
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpFailure(response.status, response.headers.get("retry-after"));
    }
    if (Number(response.headers.get("content-length")) > byteLimit) {
      throw new Error(`Input exceeds ${byteLimit} bytes`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("ATIF download has no body");
    }

    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;
    try {
      for (; ;) {
        const item = await reader.read();
        if (item.done) {
          break;
        }

        receivedBytes += item.value.byteLength;
        if (receivedBytes > byteLimit) {
          throw new Error(`Input exceeds ${byteLimit} bytes`);
        }
        chunks.push(item.value);
      }

      return Buffer.concat(chunks);
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new TypeError("ATIF download attempt timed out");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/**
 * Converts Retry-After into a bounded delay or refuses a wait the CLI cannot honor.
 *
 * @param header - Retry-After seconds/date value, or null for exponential backoff.
 * @param attempt - Zero-based retry attempt used by the fallback backoff.
 * @returns Delay in milliseconds, capped by the two-second retry budget.
 */
function retryDelay(header: string | null, attempt: number): number {
  if (!header) {
    return 100 * 2 ** attempt;
  }

  const seconds = Number(header);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  if (!Number.isFinite(delay) || delay < 0) {
    return 100 * 2 ** attempt;
  }
  if (delay > 2000) {
    throw new Error("ATIF Retry-After exceeds the allowed 2-second wait budget; retry later");
  }

  return delay;
}

/**
 * Reads bounded JSON from a file or HTTP(S), without credentials or embedded-URL fetching.
 * One retry layer covers complete downloads; invalid input and permanent HTTP failures throw.
 *
 * @param location - Local path or HTTP(S) URL.
 * @param options.maxBytes - Maximum bytes to read; defaults to 2 MiB and cannot exceed it.
 * @param options.timeoutMs - Per-attempt network deadline in milliseconds; defaults to 10000.
 * @param options.attempts - Total network attempts from 1 through 3; defaults to 3.
 * @returns Parsed JSON as unknown for caller-specific validation.
 */
export async function loadBytes(
  location: string,
  options: { maxBytes?: number; timeoutMs?: number; attempts?: number } = {},
): Promise<Buffer> {
  const byteLimit = options.maxBytes ?? MAX_BYTES;
  if (!Number.isInteger(byteLimit) || byteLimit < 1 || byteLimit > 64 * 1024 * 1024) {
    throw new Error("Input byte limit must be 1..67108864");
  }
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 10_000)) {
    throw new Error("Download timeout must be 1..10000ms");
  }
  if (options.attempts !== undefined && (!Number.isInteger(options.attempts) || options.attempts < 1 || options.attempts > 3)) {
    throw new Error("Download attempts must be 1..3");
  }

  if (!/^https?:\/\//i.test(location)) {
    // Local reads use an explicit-size buffer so file growth cannot bypass the bound.
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(location)) {
      throw new Error("Only local files and HTTP(S) URLs are supported");
    }

    const file = await open(location, "r");
    try {
      if ((await file.stat()).size > byteLimit) {
        throw new Error(`Input exceeds ${byteLimit} bytes`);
      }

      const bytes = Buffer.alloc(byteLimit + 1);
      let bytesRead = 0;
      while (bytesRead < bytes.length) {
        const read = await file.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
        if (!read.bytesRead) {
          break;
        }
        bytesRead += read.bytesRead;
      }

      if (bytesRead > byteLimit) {
        throw new Error(`Input exceeds ${byteLimit} bytes`);
      }
      return bytes.subarray(0, bytesRead);
    } finally {
      await file.close();
    }
  } else {
    // Network acquisition retries only complete transient download failures.
    try {
      new URL(location);
    } catch {
      throw new Error("Invalid HTTP(S) ATIF URL");
    }

    const timeoutMs = options.timeoutMs ?? 10_000;
    const attempts = options.attempts ?? 3;
    let body: Buffer | undefined;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        body = await downloadAttempt(location, byteLimit, timeoutMs);
        break;
      } catch (error) {
        if (error instanceof HttpFailure) {
          if (!TRANSIENT.has(error.status) || attempt + 1 >= attempts) {
            throw error;
          }
        } else if (!(error instanceof TypeError)) {
          throw error;
        } else if (attempt + 1 >= attempts) {
          throw new Error("ATIF download failed after bounded network attempts");
        }

        await new Promise(resolve => setTimeout(resolve, retryDelay(error instanceof HttpFailure ? error.retryAfter : null, attempt)));
      }
    }

    if (body === undefined) {
      throw new Error("ATIF download failed");
    }
    return body;
  }
}

/**
 * Reads and parses bounded JSON.
 *
 * @param location - Local path or HTTP(S) URL.
 * @param options - Byte/deadline/attempt limits accepted by {@link loadBytes}.
 */
export async function loadJson(
  location: string,
  options: { maxBytes?: number; timeoutMs?: number; attempts?: number } = {},
): Promise<unknown> {
  const text = (await loadBytes(location, options)).toString("utf8");

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Invalid JSON input");
  }
}
