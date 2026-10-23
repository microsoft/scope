// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Run tokens are opaque, per-run bearer credentials minted by the worker that
 * claims a run. Only the SHA-256 digest is persisted (`run.tokenHash`); the raw
 * token lives in worker memory for the lifetime of the run.
 *
 * Format: `scope_rt_<requestId>_<secret><checksum>`
 * - `requestId` is a routing hint for a point read; it is never trusted alone.
 * - `secret` is 32 random bytes, base64url-encoded (43 chars).
 * - `checksum` is a CRC32 of everything before it, base62-encoded (6 chars), so
 *   malformed or truncated tokens can be rejected without a database read.
 */
export const RUN_TOKEN_PREFIX = "scope_rt_";

const SECRET_BYTES = 32;
const SECRET_LENGTH = 43;
const CHECKSUM_LENGTH = 6;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const HASH_HEX_LENGTH = 64;

/** A freshly minted run token and the digest to persist on the claimed run. */
export interface MintedRunToken {
  /** Raw bearer token. Keep in memory only; never log or persist. */
  token: string;
  /** Hex SHA-256 digest stored as `run.tokenHash`. */
  hash: string;
}

/** The non-secret routing data extracted from a well-formed run token. */
export interface ParsedRunToken {
  requestId: string;
}

let crcTable: Uint32Array | undefined;

/** Standard CRC-32 (IEEE 802.3) over a UTF-8 string. */
function crc32(input: string): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of Buffer.from(input, "utf-8")) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Fixed-width base62 encoding of a 32-bit checksum. */
function checksum(body: string): string {
  let value = crc32(body);
  let out = "";
  for (let i = 0; i < CHECKSUM_LENGTH; i++) {
    out = BASE62[value % 62] + out;
    value = Math.floor(value / 62);
  }
  return out;
}

/** Cheap prefix test used to route a bearer to run-token verification. */
export function isRunToken(token: string): boolean {
  return token.startsWith(RUN_TOKEN_PREFIX);
}

/** Mint a new run token for a request. Call once per claim, outside any retry loop. */
export function mintRunToken(requestId: string): MintedRunToken {
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error("Cannot mint a run token for an invalid request id");
  }
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const body = `${RUN_TOKEN_PREFIX}${requestId}_${secret}`;
  const token = `${body}${checksum(body)}`;
  return { token, hash: hashRunToken(token) };
}

/** Hex SHA-256 digest of a run token (high-entropy secret, so no slow hash needed). */
export function hashRunToken(token: string): string {
  return createHash("sha256").update(token, "utf-8").digest("hex");
}

/**
 * Validate a run token's shape and checksum offline. Returns the request id it
 * claims to belong to, or `null` when malformed. Does not prove validity.
 */
export function parseRunToken(token: string): ParsedRunToken | null {
  if (!isRunToken(token)) return null;
  const tail = SECRET_LENGTH + CHECKSUM_LENGTH;
  // prefix + at least one id char + "_" separator + secret + checksum
  if (token.length < RUN_TOKEN_PREFIX.length + 2 + tail) return null;
  const body = token.slice(0, -CHECKSUM_LENGTH);
  if (checksum(body) !== token.slice(-CHECKSUM_LENGTH)) return null;
  const secret = body.slice(-SECRET_LENGTH);
  const separator = body.slice(-SECRET_LENGTH - 1, -SECRET_LENGTH);
  const requestId = body.slice(RUN_TOKEN_PREFIX.length, -SECRET_LENGTH - 1);
  if (separator !== "_" || !SECRET_PATTERN.test(secret) || !REQUEST_ID_PATTERN.test(requestId)) {
    return null;
  }
  return { requestId };
}

/** Constant-time comparison of two hex SHA-256 digests. */
export function runTokenHashesEqual(a: string, b: string): boolean {
  if (a.length !== HASH_HEX_LENGTH || b.length !== HASH_HEX_LENGTH) return false;
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  if (left.length !== 32 || right.length !== 32) return false;
  return timingSafeEqual(left, right);
}

/** Non-secret 8-char digest prefix for log correlation. */
export function runTokenHashPrefix(hash: string): string {
  return hash.slice(0, 8);
}
