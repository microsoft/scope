// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { OpenAPIObject } from "openapi3-ts/oas31";
import { describe, expect, it } from "vitest";
import { serializeOpenAPIDocument } from "./serialize.js";

describe("serializeOpenAPIDocument", () => {
  it("uses sorted keys, two spaces, LF line endings, and a final newline", () => {
    expect(serializeOpenAPIDocument({
      openapi: "3.1.0",
      info: { version: "1.0.0", title: "Test API" },
      paths: {},
    })).toBe(
      '{\n  "info": {\n    "title": "Test API",\n    "version": "1.0.0"\n  },\n  "openapi": "3.1.0",\n  "paths": {}\n}\n',
    );
  });

  it("is deterministic across nested object insertion orders", () => {
    const document: OpenAPIObject = {
      openapi: "3.1.0",
      info: { title: "Test API", version: "1.0.0" },
      paths: {},
      servers: [{ url: "/", description: "Current server" }],
      components: {
        schemas: {
          Example: {
            type: "object",
            properties: { zebra: { type: "number" }, alpha: { type: "string" } },
          },
        },
      },
    };

    // Reverse all object keys, including objects nested inside arrays.
    const reordered: OpenAPIObject = JSON.parse(JSON.stringify(document, (_key, value: unknown): unknown => {
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        const object = value as Record<string, unknown>;
        return Object.fromEntries(Object.keys(object).reverse().map((key) => [key, object[key]]));
      }
      return value;
    }));

    const serialized = serializeOpenAPIDocument(document);
    expect(serializeOpenAPIDocument(reordered)).toBe(serialized);
    expect(serializeOpenAPIDocument(document)).toBe(serialized);
  });

  it("preserves parsed content and array order without mutating the document", () => {
    const document: OpenAPIObject = {
      openapi: "3.1.0",
      info: { title: "Test\r\nAPI", version: "1.0.0" },
      paths: {},
      servers: [{ url: "/z", description: "First" }, { url: "/a" }],
      components: {
        schemas: {
          Example: { enum: ["zebra", "alpha", null], required: ["zebra", "alpha"] },
        },
      },
    };
    const original = JSON.stringify(document);
    const serialized = serializeOpenAPIDocument(document);
    const parsed: unknown = JSON.parse(serialized);

    expect(parsed).toEqual(document);
    expect(serialized).not.toContain("\r");
    expect(JSON.stringify(document)).toBe(original);
  });

  it("limits a small schema change to its corresponding line", () => {
    const document: OpenAPIObject = {
      openapi: "3.1.0",
      info: { title: "Test API", version: "1.0.0" },
      paths: {},
      components: { schemas: { Example: { type: "string", description: "Before" } } },
    };
    const before = serializeOpenAPIDocument(document).split("\n");
    const changed = structuredClone(document);
    changed.components!.schemas!.Example = { type: "string", description: "After" };
    const after = serializeOpenAPIDocument(changed).split("\n");

    // Only the edited description should change; neighboring schema lines stay put.
    expect(after).toHaveLength(before.length);
    expect(before.filter((line, index) => line !== after[index])).toEqual([
      '        "description": "Before",',
    ]);
    expect(after.filter((line, index) => line !== before[index])).toEqual([
      '        "description": "After",',
    ]);
  });
});
