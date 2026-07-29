// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { encodeCursor, decodeCursor } from "./cursor.js";

describe("encodeCursor / decodeCursor", () => {
  it("round-trips a single field", () => {
    const encoded = encodeCursor({ taskPromptId: "tp-calculator-v2" });
    expect(encoded).toBe("taskPromptId~tp-calculator-v2");
    expect(decodeCursor(encoded)).toEqual({ taskPromptId: "tp-calculator-v2" });
  });

  it("round-trips multiple fields", () => {
    const encoded = encodeCursor({ createdAt: "2025-01-15T10:00:00.000Z", id: "abc123" });
    expect(encoded).toBe("createdAt~2025-01-15T10:00:00.000Z|id~abc123");
    expect(decodeCursor(encoded)).toEqual({ createdAt: "2025-01-15T10:00:00.000Z", id: "abc123" });
  });

  it("preserves colons in values", () => {
    const encoded = encodeCursor({ submissionId: "sub:with:colons" });
    expect(decodeCursor(encoded)).toEqual({ submissionId: "sub:with:colons" });
  });

  it("throws on missing tilde", () => {
    expect(() => decodeCursor("notilde")).toThrow("missing '~'");
  });

  it("throws on empty key", () => {
    expect(() => decodeCursor("~value")).toThrow("missing '~'");
  });
});
