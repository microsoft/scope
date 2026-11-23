// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import type { OpenAPIObject } from "openapi3-ts/oas31";
import { serializeOpenAPIDocument } from "./serialize.js";

describe("serializeOpenAPIDocument", () => {
  it("uses two-space indentation, LF line endings, and exactly one trailing newline", () => {
    const document: OpenAPIObject = {
      openapi: "3.1.0",
      info: { version: "1.0.0", title: "Test API" },
      paths: {},
    };

    expect(serializeOpenAPIDocument(document)).toBe(
      '{\n' +
      '  "info": {\n' +
      '    "title": "Test API",\n' +
      '    "version": "1.0.0"\n' +
      '  },\n' +
      '  "openapi": "3.1.0",\n' +
      '  "paths": {}\n' +
      '}\n',
    );
  });

  it("ignores nested object insertion order while preserving arrays, content, and inputs", () => {
    // Equivalent documents deliberately differ in key order, including objects in arrays.
    const document: OpenAPIObject = {
      openapi: "3.1.0",
      info: { version: "1.0.0", title: "Test API" },
      servers: [
        { url: "/z", description: "Primary" },
        { url: "/a", description: "Secondary" },
      ],
      components: {
        schemas: {
          Item: {
            type: "object",
            required: ["z", "a"],
            properties: {
              z: { type: "string", enum: ["last", "first"] },
              a: { type: ["string", "null"], example: null },
            },
          },
        },
      },
    };
    const reordered: OpenAPIObject = {
      components: {
        schemas: {
          Item: {
            properties: {
              a: { example: null, type: ["string", "null"] },
              z: { enum: ["last", "first"], type: "string" },
            },
            required: ["z", "a"],
            type: "object",
          },
        },
      },
      servers: [
        { description: "Primary", url: "/z" },
        { description: "Secondary", url: "/a" },
      ],
      info: { title: "Test API", version: "1.0.0" },
      openapi: "3.1.0",
    };
    const original = JSON.stringify(document);
    const originalReordered = JSON.stringify(reordered);

    const serialized = serializeOpenAPIDocument(document);
    expect(serialized).toBe(serializeOpenAPIDocument(reordered));
    expect(serialized).toBe(serializeOpenAPIDocument(document));

    // Parsed equality preserves array positions; raw equality also detects input key mutation.
    const parsed: unknown = JSON.parse(serialized);
    expect(parsed).toEqual(document);
    expect(JSON.stringify(document)).toBe(original);
    expect(JSON.stringify(reordered)).toBe(originalReordered);
  });

  it("limits a schema description change to one serialized line", () => {
    const document: OpenAPIObject = {
      openapi: "3.1.0",
      info: { title: "Test API", version: "1.0.0" },
      components: {
        schemas: {
          Item: { type: "string", description: "Original description" },
          Unchanged: { type: "integer", minimum: 0 },
        },
      },
    };
    const changed: OpenAPIObject = {
      ...document,
      components: {
        schemas: {
          ...document.components?.schemas,
          Item: { type: "string", description: "Updated description" },
        },
      },
    };

    // Compare every line, not just file length or parsed content, to enforce diff locality.
    const before = serializeOpenAPIDocument(document).split("\n");
    const after = serializeOpenAPIDocument(changed).split("\n");
    expect(after).toHaveLength(before.length);
    const changedLines = before.flatMap((line, index) =>
      line === after[index] ? [] : [{ before: line, after: after[index] }],
    );
    expect(changedLines).toEqual([{
      before: '        "description": "Original description",',
      after: '        "description": "Updated description",',
    }]);
  });
});
