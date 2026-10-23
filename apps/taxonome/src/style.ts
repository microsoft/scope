// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { styleText } from "node:util";
import type { Command } from "commander";

type StyleFormat = Parameters<typeof styleText>[0];

/** Stream capability used for color decisions; production passes `process.stderr`. */
export interface ColorStream {
  /** True only when the diagnostic/help stream is attached to an interactive terminal. */
  isTTY?: boolean;
}

/** Environment variables that affect common CLI color behavior. */
export interface ColorEnvironment {
  /** Other environment values are ignored by color policy. */
  [name: string]: string | undefined;
  /** Presence disables color, including when FORCE_COLOR is also set. */
  NO_COLOR?: string;
  /** `0` disables; any other defined value explicitly enables color. */
  FORCE_COLOR?: string;
  /** CI defaults to plain output unless FORCE_COLOR explicitly enables color. */
  CI?: string;
  /** `dumb` terminals do not receive color unless FORCE_COLOR explicitly enables it. */
  TERM?: string;
}

/** Semantic styles used only for diagnostics, progress, errors, and help. */
export interface TaxonomeStyle {
  /** Whether ANSI styling is enabled for the configured diagnostic stream. */
  enabled: boolean;
  /** Section/help title. */
  title(text: string): string;
  /** Command name in help. */
  command(text: string): string;
  /** Option flag in help. */
  option(text: string): string;
  /** Positional argument in help. */
  argument(text: string): string;
  /** Help description text. */
  description(text: string): string;
  /** Strong diagnostic label. */
  label(text: string): string;
  /** Successful status text; callers still emit the word PASS. */
  pass(text: string): string;
  /** Failed status text; callers still emit the word FAIL. */
  fail(text: string): string;
  /** Warning text with an explicit textual warning message. */
  warning(text: string): string;
  /** Error text with an explicit textual error message. */
  error(text: string): string;
  /** Secondary context such as case IDs and sample numbers. */
  dim(text: string): string;
}

/**
 * Decides whether diagnostics/help should contain ANSI color.
 *
 * @param stream - Diagnostic stream whose TTY state controls the default.
 * @param environment - Color-related environment variables; defaults to the process environment.
 * @returns True for interactive TTYs or explicit FORCE_COLOR, unless NO_COLOR/FORCE_COLOR=0 disables it.
 */
export function shouldUseColor(
  stream: ColorStream = process.stderr,
  environment: ColorEnvironment = process.env,
): boolean {
  if (environment.NO_COLOR !== undefined || environment.FORCE_COLOR === "0") {
    return false;
  }
  if (environment.FORCE_COLOR !== undefined) {
    return true;
  }
  if (environment.CI || environment.TERM === "dumb") {
    return false;
  }
  return stream.isTTY === true;
}

/**
 * Creates restrained semantic styling for one diagnostic stream.
 *
 * @param stream - Diagnostic/help stream; defaults to stderr.
 * @param environment - Environment used for color policy; defaults to process.env.
 * @returns Style helpers that return plain text when color is disabled.
 */
export function createTaxonomeStyle(
  stream: ColorStream = process.stderr,
  environment: ColorEnvironment = process.env,
): TaxonomeStyle {
  const enabled = shouldUseColor(stream, environment);
  const apply = (format: StyleFormat, text: string) =>
    enabled ? styleText(format, text, { validateStream: false }) : text;

  return {
    enabled,
    title: text => apply(["bold", "cyan"], text),
    command: text => apply("cyan", text),
    option: text => apply("green", text),
    argument: text => apply("yellow", text),
    description: text => apply("italic", text),
    label: text => apply("bold", text),
    pass: text => apply(["bold", "green"], text),
    fail: text => apply(["bold", "red"], text),
    warning: text => apply("yellow", text),
    error: text => apply(["bold", "red"], text),
    dim: text => apply("gray", text),
  };
}

/**
 * Applies semantic styling to Commander's standard concise help layout.
 *
 * @param command - Root command or subcommand whose helper should be styled.
 * @param style - Diagnostic/help style bound to stderr color policy.
 */
export function configureTaxonomeHelp(command: Command, style: TaxonomeStyle): void {
  command.configureHelp({
    styleTitle: style.title,
    styleCommandText: style.command,
    styleCommandDescription: style.description,
    styleDescriptionText: style.description,
    styleOptionText: style.option,
    styleArgumentText: style.argument,
    styleSubcommandText: style.command,
  });
}
