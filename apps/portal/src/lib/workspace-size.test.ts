// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { formatSnapshotBytes, summarizeWorkspaceSizes } from "./workspace-size";

describe("formatSnapshotBytes", () => {
  it("keeps small values in bytes", () => {
    expect(formatSnapshotBytes(0)).toBe("0 B");
    expect(formatSnapshotBytes(1023)).toBe("1023 B");
  });

  it("scales through KB, MB and GB", () => {
    expect(formatSnapshotBytes(1536)).toBe("1.5 KB");
    expect(formatSnapshotBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatSnapshotBytes(2.25 * 1024 ** 3)).toBe("2.3 GB");
  });

  it("caps at TB", () => {
    expect(formatSnapshotBytes(2048 * 1024 ** 4)).toBe("2048.0 TB");
  });
});

describe("summarizeWorkspaceSizes", () => {
  it("sums recorded sizes and counts missing ones", () => {
    expect(
      summarizeWorkspaceSizes([
        { workspaceSizeBytes: 100 },
        {},
        { workspaceSizeBytes: 0 },
        { workspaceSizeBytes: 50 },
      ]),
    ).toEqual({ totalBytes: 150, measured: 3, missing: 1 });
  });

  it("reports nothing measured for legacy runs", () => {
    expect(summarizeWorkspaceSizes([{}, {}])).toEqual({ totalBytes: 0, measured: 0, missing: 2 });
  });

  it("handles an empty turn list", () => {
    expect(summarizeWorkspaceSizes([])).toEqual({ totalBytes: 0, measured: 0, missing: 0 });
  });
});
