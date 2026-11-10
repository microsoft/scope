// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createStyle, parseConfirm, parseSelection, Prompter } from "./prompt.js";

/** A prompter fed by scripted input lines, capturing everything it prints. */
function scriptedPrompter(lines: string[], { endInput = true } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  let printed = "";
  output.on("data", (chunk: Buffer) => {
    printed += chunk.toString();
  });

  const prompter = new Prompter(input, output, createStyle(false));
  input.write(lines.map((line) => `${line}\n`).join(""));
  if (endInput) input.end();

  return { prompter, printed: () => printed };
}

describe("parseSelection", () => {
  it("maps 1-based numbers to zero-based choices", () => {
    expect(parseSelection("2", 3)).toEqual({ kind: "choice", index: 1 });
    expect(parseSelection(" 3 ", 3)).toEqual({ kind: "choice", index: 2 });
  });

  it("rejects out-of-range and non-numeric answers", () => {
    expect(parseSelection("0", 3)).toBeUndefined();
    expect(parseSelection("4", 3)).toBeUndefined();
    expect(parseSelection("1.5", 3)).toBeUndefined();
    expect(parseSelection("docker", 3)).toBeUndefined();
  });

  it("uses the default only for an empty answer", () => {
    expect(parseSelection("", 3, { defaultIndex: 1 })).toEqual({ kind: "choice", index: 1 });
    expect(parseSelection("", 3)).toBeUndefined();
  });

  it("understands quit, and back only when allowed", () => {
    expect(parseSelection("q", 3)).toEqual({ kind: "quit" });
    expect(parseSelection("Quit", 3)).toEqual({ kind: "quit" });
    expect(parseSelection("b", 3, { allowBack: true })).toEqual({ kind: "back" });
    expect(parseSelection("b", 3)).toBeUndefined();
  });
});

describe("parseConfirm", () => {
  it("accepts y/yes/n/no in any case and uses the default for an empty answer", () => {
    expect(parseConfirm("Y", false)).toBe(true);
    expect(parseConfirm("yes", false)).toBe(true);
    expect(parseConfirm("NO", true)).toBe(false);
    expect(parseConfirm("", true)).toBe(true);
    expect(parseConfirm("", false)).toBe(false);
    expect(parseConfirm("maybe", true)).toBeUndefined();
  });
});

describe("Prompter", () => {
  it("prints a numbered menu with hints and re-asks until the answer is valid", async () => {
    const { prompter, printed } = scriptedPrompter(["9", "x", "2"]);

    const selection = await prompter.select("Pick one", [{ label: "Alpha", hint: "first" }, { label: "Beta" }], { allowBack: true });

    expect(selection).toEqual({ kind: "choice", index: 1 });
    expect(printed()).toContain("? Pick one");
    expect(printed()).toContain("1) Alpha");
    expect(printed()).toContain("first");
    expect(printed()).toContain("(b = back, q = quit)");
    expect(printed().match(/Please enter a number from 1 to 2, b or q/g)).toHaveLength(2);
  });

  it("marks and applies the default choice on Enter", async () => {
    const { prompter, printed } = scriptedPrompter([""]);

    const selection = await prompter.select("Pick one", [{ label: "Alpha" }, { label: "Beta" }], { defaultIndex: 1 });

    expect(selection).toEqual({ kind: "choice", index: 1 });
    expect(printed()).toContain("2) Beta (default)");
    expect(printed()).toContain("Choose 1-2 [2]:");
  });

  it("answers several questions from input that arrived up front", async () => {
    // Piped input arrives before the questions are asked; no line may be lost.
    const { prompter } = scriptedPrompter(["1", "n", "y"]);

    expect(await prompter.select("Pick", [{ label: "Only" }])).toEqual({ kind: "choice", index: 0 });
    expect(await prompter.confirm("Sure?", true)).toBe(false);
    expect(await prompter.confirm("Really?", false)).toBe(true);
  });

  it("treats the end of input as quit for menus and no for questions", async () => {
    const { prompter } = scriptedPrompter([]);

    expect(await prompter.select("Pick", [{ label: "Only" }])).toEqual({ kind: "quit" });
    expect(await prompter.confirm("Sure?", true)).toBe(false);
  });

  it("returns quit once closed while waiting for an answer", async () => {
    const { prompter } = scriptedPrompter([], { endInput: false });

    const pending = prompter.select("Pick", [{ label: "Only" }]);
    prompter.close();

    expect(await pending).toEqual({ kind: "quit" });
  });
});

describe("createStyle", () => {
  it("adds ANSI codes only when enabled", () => {
    expect(createStyle(false).bold("x")).toBe("x");
    expect(createStyle(true).bold("x")).toBe("\u001b[1mx\u001b[22m");
  });
});
