// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Readable } from "node:stream";
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseRunInputRecords,
  readRunInputSelections,
} from "./run-inputs.js";

const chunks = (...values: Array<string | Uint8Array>) =>
  Readable.from(values);

describe("Taxonome run path-list input", () => {
  it("parses LF/CRLF and preserves literal path syntax", async () => {
    await expect(parseRunInputRecords(chunks(
      " spaced path \r\n",
      "\"quoted\"#literal\n",
      "-leading",
    ), false, "paths.txt")).resolves.toEqual([
      " spaced path ",
      "\"quoted\"#literal",
      "-leading",
    ]);
  });

  it("parses NUL paths containing newlines and CR characters", async () => {
    await expect(parseRunInputRecords(chunks(
      "line\nname\0carriage\rname\0unterminated",
    ), true, "-", undefined)).resolves.toEqual([
      "line\nname",
      "carriage\rname",
      "unterminated",
    ]);
  });

  it("handles UTF-8 code points split across chunks", async () => {
    const bytes = Buffer.from("unicodé.json\n", "utf8");
    await expect(parseRunInputRecords(chunks(
      bytes.subarray(0, 7),
      bytes.subarray(7, 8),
      bytes.subarray(8),
    ), false, "paths.txt")).resolves.toEqual(["unicodé.json"]);
  });

  it.each([
    ["\n", false, /record 1.*empty interior/],
    ["one\n\ntwo", false, /record 2.*empty interior/],
    ["one\0\0two", true, /record 2.*empty interior/],
    ["", false, /contains no paths/],
  ] as const)("rejects malformed record stream %#", async (
    value,
    nullDelimited,
    expected,
  ) => {
    await expect(parseRunInputRecords(
      chunks(value),
      nullDelimited,
      "paths.txt",
    )).rejects.toThrow(expected);
  });

  it("rejects invalid UTF-8 and cancellation", async () => {
    await expect(parseRunInputRecords(
      chunks(Uint8Array.from([0xc3, 0x28])),
      false,
      "paths.txt",
    )).rejects.toThrow("not valid UTF-8");

    const controller = new AbortController();
    controller.abort();
    await expect(parseRunInputRecords(
      chunks("one\n"),
      false,
      "-",
      controller.signal,
    )).rejects.toThrow("cancelled");

    const waiting = new Readable({ read() {} });
    const activeController = new AbortController();
    const parsing = parseRunInputRecords(
      waiting,
      false,
      "-",
      activeController.signal,
    );
    activeController.abort();
    await expect(parsing).rejects.toThrow("cancelled");
    expect(waiting.destroyed).toBe(true);
  });

  it("resolves from CWD, deduplicates aliases, and retains per-input errors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taxonome-list-"));
    try {
      await writeFile(join(directory, "one.json"), "{}");
      await symlink("one.json", join(directory, "alias.json"));
      await mkdir(join(directory, "folder"));
      await writeFile(
        join(directory, "paths.txt"),
        [
          "one.json",
          "alias.json",
          "missing.json",
          "folder",
        ].join("\n"),
      );
      const selections = await readRunInputSelections("paths.txt", {
        cwd: directory,
      });

      expect(selections).toHaveLength(3);
      expect(selections[0]).toMatchObject({
        record: 1,
        original: "one.json",
      });
      expect(selections[0].error).toBeUndefined();
      expect(selections[1]).toMatchObject({
        record: 3,
        original: "missing.json",
        error: expect.any(Error),
      });
      expect(selections[2]).toMatchObject({
        record: 4,
        original: "folder",
        error: expect.any(Error),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
