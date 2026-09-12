// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { styleText } from "node:util";

export { styleText };

/** Color mapping for log levels — matches the Ink components' LEVEL_COLORS. */
export const LEVEL_COLORS: Record<string, Parameters<typeof styleText>[0]> = {
  info: "white",
  warn: "yellow",
  error: "red",
  debug: "gray",
};

/** Color mapping for worker types — matches the Ink components' WORKER_COLORS. */
export const WORKER_COLORS: Record<string, Parameters<typeof styleText>[0]> = {
  "coder-acp-claude-code": "cyan",
  "coder-acp-copilot": "magenta",
};

/** Format a log level with its associated color. */
export function colorLevel(level: string): string {
  const color = LEVEL_COLORS[level.toLowerCase()] ?? "white";
  return styleText(color, level.toUpperCase().padEnd(5));
}

/** Format a timestamp dimmed. */
export function dimTimestamp(ts: string): string {
  return styleText("gray", ts);
}

/** Format an error message. */
export function errorText(msg: string): string {
  return styleText("red", styleText("bold", msg));
}

/** Format a success message. */
export function successText(msg: string): string {
  return styleText("green", styleText("bold", msg));
}

/** Format a label (key in key: value pairs). */
export function label(msg: string): string {
  return styleText("bold", msg);
}

/** Format a value in cyan. */
export function value(msg: string): string {
  return styleText("cyan", msg);
}

/** Format a banner/section header. */
export function banner(msg: string): string {
  return styleText("bold", styleText("cyan", msg));
}

/** Format a warning banner. */
export function warnBanner(msg: string): string {
  return styleText("bold", styleText("yellow", msg));
}

/** Format a criterion status with colored, shape-distinct icon. */
export function criterionIcon(evaluated: boolean, passed: boolean): string {
  if (!evaluated) return styleText("yellow", "○");
  return passed ? styleText("green", "●") : styleText("red", "✗");
}
