// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { createCli } from "./cli.js";
import {
  createTaxonomeStyle,
  shouldUseColor,
  type ColorEnvironment,
  type ColorStream,
} from "./style.js";

const ANSI_PATTERN = /\u001b\[[0-9;]*m/;

/** Creates the minimal stream shape needed to test TTY policy. */
function stream(isTTY: boolean): ColorStream {
  return { isTTY };
}

/** Creates a process-like environment without inheriting the test runner's color variables. */
function environment(overrides: ColorEnvironment = {}): ColorEnvironment {
  return { TERM: "xterm-256color", ...overrides };
}

describe("Taxonome color policy", () => {
  it("enables color for a TTY and disables it for pipes, CI, dumb terminals, and explicit opt-out", () => {
    expect(shouldUseColor(stream(true), environment())).toBe(true);
    expect(shouldUseColor(stream(false), environment())).toBe(false);
    expect(shouldUseColor(stream(true), environment({ CI: "true" }))).toBe(false);
    expect(shouldUseColor(stream(true), environment({ TERM: "dumb" }))).toBe(false);
    expect(shouldUseColor(stream(true), environment({ FORCE_COLOR: "0" }))).toBe(false);
    expect(shouldUseColor(stream(true), environment({ NO_COLOR: "1" }))).toBe(false);
  });

  it("honors FORCE_COLOR for non-TTY diagnostics but gives NO_COLOR precedence", () => {
    expect(shouldUseColor(stream(false), environment({ FORCE_COLOR: "1" }))).toBe(true);
    expect(shouldUseColor(stream(true), environment({ FORCE_COLOR: "1", NO_COLOR: "1" }))).toBe(false);
  });

  it("styles semantic text only when enabled and never removes textual status labels", () => {
    const colorful = createTaxonomeStyle(stream(true), environment());
    const plain = createTaxonomeStyle(stream(true), environment({ NO_COLOR: "1" }));

    expect(colorful.pass("PASS")).toMatch(ANSI_PATTERN);
    expect(colorful.fail("FAIL")).toMatch(ANSI_PATTERN);
    expect(colorful.error("taxonome:")).toMatch(ANSI_PATTERN);
    expect(colorful.pass("PASS")).toContain("PASS");
    expect(colorful.fail("FAIL")).toContain("FAIL");

    expect(plain.pass("PASS")).toBe("PASS");
    expect(plain.fail("FAIL")).toBe("FAIL");
    expect(plain.error("taxonome:")).toBe("taxonome:");
  });

  it("uses color in interactive help and plain text when NO_COLOR disables it", () => {
    const colorfulCli = createCli(createTaxonomeStyle(stream(true), environment()));
    const plainCli = createCli(createTaxonomeStyle(stream(true), environment({ NO_COLOR: "1" })));
    const colorfulHelp = colorfulCli.helpInformation();
    const colorfulRunHelp = colorfulCli.commands.find(command => command.name() === "run")!.helpInformation();
    const plainHelp = plainCli.helpInformation();

    expect(colorfulHelp).toMatch(ANSI_PATTERN);
    expect(colorfulRunHelp).toMatch(ANSI_PATTERN);
    expect(colorfulHelp).toContain("Usage:");
    expect(plainHelp).not.toMatch(ANSI_PATTERN);
    expect(plainHelp).toContain("Usage:");
  });
});
