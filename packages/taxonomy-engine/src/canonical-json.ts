// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash } from "node:crypto";

/** JSON value accepted by canonical serialization. */
export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

function validateUnicode(value: string, path: string): void {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (
        index + 1 >= value.length ||
        next < 0xdc00 ||
        next > 0xdfff
      ) {
        throw new Error(`Canonical JSON rejects an unpaired surrogate at ${path}`);
      }
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error(`Canonical JSON rejects an unpaired surrogate at ${path}`);
    }
  }
}

/** Serializes JSON using the RFC 8785 ordering and ECMAScript primitives. */
export function canonicalJsonStringify(value: unknown): string {
  const visited = new Set<object>();

  function serialize(candidate: unknown, path: string): string {
    if (
      candidate === null ||
      typeof candidate === "boolean" ||
      typeof candidate === "string"
    ) {
      if (typeof candidate === "string") validateUnicode(candidate, path);
      return JSON.stringify(candidate);
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw new Error(`Canonical JSON cannot serialize a nonfinite number at ${path}`);
      }
      return JSON.stringify(candidate);
    }
    if (Array.isArray(candidate)) {
      if (visited.has(candidate)) {
        throw new Error(`Canonical JSON cannot serialize a cycle at ${path}`);
      }
      visited.add(candidate);
      for (let index = 0; index < candidate.length; index++) {
        if (!(index in candidate)) {
          throw new Error(`Canonical JSON rejects a sparse array at ${path}[${index}]`);
        }
      }
      const serialized = candidate.map((child, index) => {
        if (child === undefined || typeof child === "function" || typeof child === "symbol") {
          throw new Error(`Canonical JSON cannot serialize ${typeof child} at ${path}[${index}]`);
        }
        return serialize(child, `${path}[${index}]`);
      });
      visited.delete(candidate);
      return `[${serialized.join(",")}]`;
    }
    if (candidate && typeof candidate === "object") {
      if (visited.has(candidate)) {
        throw new Error(`Canonical JSON cannot serialize a cycle at ${path}`);
      }
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`Canonical JSON requires a plain object at ${path}`);
      }
      visited.add(candidate);
      const entries = Object.entries(candidate as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => {
          validateUnicode(key, `${path} property name`);
          if (child === undefined || typeof child === "function" || typeof child === "symbol") {
            throw new Error(`Canonical JSON cannot serialize ${typeof child} at ${path}.${key}`);
          }
          return `${JSON.stringify(key)}:${serialize(child, `${path}.${key}`)}`;
        });
      visited.delete(candidate);
      return `{${entries.join(",")}}`;
    }
    throw new Error(`Canonical JSON cannot serialize ${typeof candidate} at ${path}`);
  }

  return serialize(value, "$");
}

/** Computes lowercase hexadecimal SHA-256 over canonical UTF-8 JSON bytes. */
export function canonicalJsonSha256(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJsonStringify(value), "utf8")
    .digest("hex");
}
