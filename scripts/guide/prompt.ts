// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// =============================================================================
// prompt.ts — Dependency-free numbered menus and yes/no questions
// =============================================================================
// Built on node:readline so the guide works right after `pnpm install` without
// extra packages. Streams are injectable so tests can script answers.
// =============================================================================

import { createInterface, type Interface } from "node:readline";

/** Minimal ANSI styling that degrades to plain text when colors are off. */
export interface Style {
  bold(text: string): string;
  dim(text: string): string;
  cyan(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  red(text: string): string;
}

/**
 * Create a {@link Style}. Colors are enabled only for interactive terminals and
 * respect the NO_COLOR convention.
 *
 * @param enabled - Force colors on or off (default: detect from stdout and env).
 */
export function createStyle(enabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb"): Style {
  const wrap = (open: number, close: number) => (text: string) => (enabled ? `\u001b[${open}m${text}\u001b[${close}m` : text);

  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    cyan: wrap(36, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    red: wrap(31, 39),
  };
}

/** One entry in a numbered menu. */
export interface MenuOption {
  label: string;
  /** Secondary text shown dimmed under the label. */
  hint?: string;
}

/** Result of a menu prompt. `index` is zero-based. */
export type Selection = { kind: "choice"; index: number } | { kind: "back" } | { kind: "quit" };

/** Options for {@link Prompter.select}. */
export interface SelectOptions {
  /** Zero-based option chosen when the user just presses Enter (default: none, Enter re-asks). */
  defaultIndex?: number;
  /** Offer `b` to go back to the previous question (default: false). */
  allowBack?: boolean;
}

/**
 * Interpret a menu answer. Accepts a 1-based number, `b`/`back`, `q`/`quit`,
 * or an empty answer when a default exists.
 *
 * @returns The selection, or `undefined` when the answer is invalid.
 */
export function parseSelection(answer: string, optionCount: number, options: SelectOptions = {}): Selection | undefined {
  const normalized = answer.trim().toLowerCase();

  if (normalized === "") {
    return options.defaultIndex === undefined ? undefined : { kind: "choice", index: options.defaultIndex };
  }
  if (normalized === "q" || normalized === "quit" || normalized === "exit") return { kind: "quit" };
  if (normalized === "b" || normalized === "back") return options.allowBack ? { kind: "back" } : undefined;

  if (!/^\d+$/.test(normalized)) return undefined;
  const number = Number(normalized);
  return number >= 1 && number <= optionCount ? { kind: "choice", index: number - 1 } : undefined;
}

/**
 * Interpret a yes/no answer.
 *
 * @returns The answer, the default for an empty answer, or `undefined` when invalid.
 */
export function parseConfirm(answer: string, defaultValue: boolean): boolean | undefined {
  const normalized = answer.trim().toLowerCase();

  if (normalized === "") return defaultValue;
  if (normalized === "y" || normalized === "yes") return true;
  if (normalized === "n" || normalized === "no") return false;
  return undefined;
}

/**
 * Asks questions on a single readline interface. Lines that arrive before a
 * question is asked are queued, so piped or scripted input is never lost.
 * Ctrl+C or end of input closes the prompter and is treated as "quit".
 */
export class Prompter {
  private readonly readline: Interface;
  private readonly terminal: boolean;
  private readonly bufferedLines: string[] = [];
  private pendingAnswer?: (line: string | undefined) => void;
  private closed = false;

  /**
   * @param input - Where answers are read from (default: stdin).
   * @param output - Where questions and menus are written (default: stdout).
   * @param style - Text styling (default: auto-detected colors).
   */
  constructor(
    input: NodeJS.ReadableStream = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout,
    private readonly style: Style = createStyle(),
  ) {
    this.terminal = Boolean((output as { isTTY?: boolean }).isTTY);
    this.readline = createInterface({ input, output, terminal: this.terminal });

    // Deliver each line to the waiting question, or queue it for the next one.
    this.readline.on("line", (line) => {
      if (this.pendingAnswer) this.settle(line);
      else this.bufferedLines.push(line);
    });

    // End of input and Ctrl+C both end the conversation.
    this.readline.on("close", () => {
      this.closed = true;
      this.settle(undefined);
    });
    this.readline.on("SIGINT", () => {
      this.output.write("\n");
      this.close();
    });
  }

  /** Resolve the waiting question, if any. */
  private settle(line: string | undefined): void {
    const resolve = this.pendingAnswer;
    this.pendingAnswer = undefined;
    resolve?.(line);
  }

  /**
   * Show a prompt and wait for one line of input.
   *
   * @returns The answer, or `undefined` if input ended or the user pressed Ctrl+C.
   */
  ask(prompt: string): Promise<string | undefined> {
    // Typed-ahead answers: a terminal already echoed them, piped input did not.
    const buffered = this.bufferedLines.shift();
    if (buffered !== undefined) {
      this.output.write(this.terminal ? `${prompt}\n` : `${prompt}${buffered}\n`);
      return Promise.resolve(buffered);
    }
    if (this.closed) return Promise.resolve(undefined);

    this.readline.setPrompt(prompt);
    this.readline.prompt();
    return new Promise((resolve) => {
      this.pendingAnswer = resolve;
    });
  }

  /** Print a numbered menu and wait for a valid selection. */
  async select(question: string, options: MenuOption[], selectOptions: SelectOptions = {}): Promise<Selection> {
    const { bold, dim, cyan } = this.style;
    this.output.write(`\n${bold(cyan("?"))} ${bold(question)}\n`);

    // List options with right-aligned numbers so multi-digit menus stay aligned.
    const width = String(options.length).length;
    options.forEach((option, index) => {
      const number = String(index + 1).padStart(width);
      const marker = index === selectOptions.defaultIndex ? ` ${dim("(default)")}` : "";
      this.output.write(`  ${cyan(`${number})`)} ${option.label}${marker}\n`);
      if (option.hint) this.output.write(`  ${" ".repeat(width + 1)} ${dim(option.hint)}\n`);
    });

    const keys = [selectOptions.allowBack ? "b = back" : undefined, "q = quit"].filter(Boolean).join(", ");
    this.output.write(dim(`  (${keys})\n`));

    const defaultText = selectOptions.defaultIndex === undefined ? "" : ` [${selectOptions.defaultIndex + 1}]`;
    for (;;) {
      const answer = await this.ask(`Choose 1-${options.length}${defaultText}: `);
      if (answer === undefined) return { kind: "quit" };

      const selection = parseSelection(answer, options.length, selectOptions);
      if (selection) return selection;
      this.output.write(this.style.yellow(`Please enter a number from 1 to ${options.length}${selectOptions.allowBack ? ", b" : ""} or q.\n`));
    }
  }

  /**
   * Ask a yes/no question until the answer is valid.
   *
   * @returns The answer; `false` if input ended or the user pressed Ctrl+C.
   */
  async confirm(question: string, defaultValue: boolean): Promise<boolean> {
    const choices = defaultValue ? "[Y/n]" : "[y/N]";

    for (;;) {
      const answer = await this.ask(`${this.style.bold(question)} ${choices} `);
      if (answer === undefined) return false;

      const confirmed = parseConfirm(answer, defaultValue);
      if (confirmed !== undefined) return confirmed;
      this.output.write(this.style.yellow("Please answer y or n.\n"));
    }
  }

  /** Release the input stream so child processes can own the terminal. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readline.close();
  }
}
