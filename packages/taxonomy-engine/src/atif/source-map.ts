// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type {
  AtifProvenance,
  AtifSourceDescriptor,
  AtifSourceMapping,
} from "./types.js";

type PathSegment = string | number;

/** Parses the definite JSONPath subset used by ATIF provenance mappings. */
function pathSegments(path: string): PathSegment[] {
  if (!path.startsWith("$")) throw new Error(`Invalid ATIF source path '${path}'`);
  const segments: PathSegment[] = [];
  let index = 1;
  while (index < path.length) {
    if (path[index] === ".") {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(
        path.slice(index + 1),
      );
      if (!match) throw new Error(`Invalid ATIF source path '${path}'`);
      segments.push(match[0]);
      index += match[0].length + 1;
      continue;
    }
    if (path[index] !== "[") {
      throw new Error(`Invalid ATIF source path '${path}'`);
    }
    const tokenStart = index + 1;
    const quote = path[tokenStart];
    if (quote === '"' || quote === "'") {
      let cursor = tokenStart + 1;
      while (cursor < path.length) {
        if (path[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (path[cursor] === quote) break;
        cursor++;
      }
      if (
        cursor >= path.length ||
        path[cursor + 1] !== "]"
      ) {
        throw new Error(`Invalid ATIF source path '${path}'`);
      }
      const token = path.slice(tokenStart, cursor + 1);
      if (quote === '"') {
        segments.push(JSON.parse(token) as string);
      } else {
        const content = token.slice(1, -1);
        let decoded = "";
        for (let offset = 0; offset < content.length; offset++) {
          if (content[offset] !== "\\") {
            decoded += content[offset];
            continue;
          }
          const escaped = content[++offset];
          if (escaped === undefined) {
            throw new Error(`Invalid ATIF source path '${path}'`);
          }
          const simple: Record<string, string> = {
            "'": "'",
            '"': '"',
            "\\": "\\",
            "/": "/",
            b: "\b",
            f: "\f",
            n: "\n",
            r: "\r",
            t: "\t",
          };
          if (escaped === "u") {
            const hex = content.slice(offset + 1, offset + 5);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              throw new Error(`Invalid ATIF source path '${path}'`);
            }
            decoded += String.fromCharCode(Number.parseInt(hex, 16));
            offset += 4;
          } else if (escaped in simple) {
            decoded += simple[escaped];
          } else {
            throw new Error(`Invalid ATIF source path '${path}'`);
          }
        }
        segments.push(decoded);
      }
      index = cursor + 2;
      continue;
    }
    let close = tokenStart;
    while (close < path.length && path[close] !== "]") close++;
    const token = path.slice(tokenStart, close);
    if (close >= path.length || !/^\d+$/.test(token)) {
      throw new Error(`Invalid ATIF source path '${path}'`);
    }
    segments.push(Number(token));
    index = close + 1;
  }
  return segments;
}

/** Renders definite source paths canonically without enabling query syntax. */
function renderPath(segments: readonly PathSegment[]): string {
  return `$${segments.map(segment =>
    typeof segment === "number"
      ? `[${segment}]`
      : /^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)
        ? `.${segment}`
        : `[${JSON.stringify(segment)}]`
  ).join("")}`;
}

function startsWithSegments(
  value: readonly PathSegment[],
  prefix: readonly PathSegment[],
): boolean {
  return prefix.length <= value.length &&
    prefix.every((segment, index) => segment === value[index]);
}

/** Creates identity mapping for a bare object or singleton wrapper. */
export function createAtifProvenance(
  source: AtifSourceDescriptor,
  containerPrefix: string,
  sourceVersion: AtifProvenance["source_version"],
): AtifProvenance {
  return {
    source: { ...source },
    source_version: sourceVersion,
    container_prefix: containerPrefix,
    upcasters: [],
    mappings: [{
      normalized_prefix: "$",
      original_prefix: containerPrefix,
    }],
  };
}

/** Appends one mapping operation without mutating earlier provenance. */
export function addAtifMapping(
  provenance: AtifProvenance,
  mapping: AtifSourceMapping,
): AtifProvenance {
  return {
    ...provenance,
    mappings: [...provenance.mappings, mapping],
  };
}

/** Resolves a normalized path through the longest matching prefix mapping. */
export function originalAtifPath(
  provenance: AtifProvenance,
  normalizedPath: string,
): {
  path: string;
  generated_by?: string;
  source?: AtifSourceDescriptor;
} {
  const normalizedSegments = pathSegments(normalizedPath);
  let selected:
    | {
      mapping: AtifSourceMapping;
      index: number;
      segments: PathSegment[];
    }
    | undefined;
  for (const [index, mapping] of provenance.mappings.entries()) {
    const segments = pathSegments(mapping.normalized_prefix);
    if (!startsWithSegments(normalizedSegments, segments)) continue;
    if (
      !selected ||
      segments.length > selected.segments.length ||
      (
        segments.length === selected.segments.length &&
        index > selected.index
      )
    ) {
      selected = { mapping, index, segments };
    }
  }
  const mapping = selected?.mapping ?? {
    normalized_prefix: "$",
    original_prefix: provenance.container_prefix,
  };
  const originalSegments = pathSegments(mapping.original_prefix);
  const suffix = selected && mapping.mode !== "anchor"
    ? normalizedSegments.slice(selected.segments.length)
    : [];
  return {
    path: renderPath([...originalSegments, ...suffix]),
    ...(mapping.generated_by
      ? { generated_by: mapping.generated_by }
      : {}),
    source: mapping.source ?? provenance.source,
  };
}
