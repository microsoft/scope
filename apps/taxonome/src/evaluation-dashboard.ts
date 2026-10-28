// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  clearLine,
  cursorTo,
  moveCursor,
} from "node:readline";
import { stripVTControlCharacters } from "node:util";
import type {
  EvaluationJob,
  EvaluationJobOutcome,
} from "./evaluation-jobs.js";
import { elementProgressLabel } from "./evaluation-progress.js";
import type { TaxonomeStyle } from "./style.js";

type DashboardStream = NodeJS.WritableStream & {
  isTTY?: boolean;
  columns?: number;
};

type JobStatus = "waiting" | "running" | "passed" | "failed";

/** Dashboard construction options. */
export interface EvaluationDashboardOptions {
  /** Stable planned jobs. */
  jobs: readonly EvaluationJob[];
  /** Taxonomy-ordered selected element IDs. */
  elementOrder: readonly string[];
  /** Loaded taxonomy ID. */
  taxonomyId: string;
  /** Loaded taxonomy version. */
  taxonomyVersion: string;
  /** Selected split or `all`. */
  split: string;
  /** Configured global worker count. */
  concurrency: number;
  /** Diagnostic style selected for stderr. */
  style: TaxonomeStyle;
  /** Diagnostic stream; production passes stderr. */
  stream?: DashboardStream;
  /** JSON mode disables cursor control and ANSI. */
  json?: boolean;
  /** Minimum interval between TTY redraws. */
  throttleMs?: number;
  /** Running spinner redraw cadence. */
  spinnerMs?: number;
}

/** Numeric snapshot used by rendering and tests. */
export interface ElementDashboardSnapshot {
  id: string;
  label: string;
  implementation: "prompt" | "deterministic";
  total: number;
  done: number;
  pass: number;
  fail: number;
  running: number;
  waiting: number;
  active: string;
  status: "PASS" | "FAIL" | "RUN" | "WAIT";
}

/** Tracks and renders only the terminal lines owned by evaluation progress. */
export class EvaluationDashboard {
  private readonly stream: DashboardStream;
  private readonly tty: boolean;
  private readonly json: boolean;
  private readonly throttleMs: number;
  private readonly spinnerMs: number;
  private readonly statuses: JobStatus[];
  private readonly workerBySequence = new Map<number, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private spinnerTimer: ReturnType<typeof setInterval> | undefined;
  private lineCount = 0;
  private rendered = false;
  private finalized = false;
  private spinnerIndex = 0;
  private startedAt = Date.now();

  constructor(private readonly options: EvaluationDashboardOptions) {
    this.stream = options.stream ?? process.stderr;
    this.json = options.json ?? false;
    this.tty = this.stream.isTTY === true && !this.json;
    this.throttleMs = options.throttleMs ?? 50;
    this.spinnerMs = options.spinnerMs ?? 80;
    this.statuses = options.jobs.map(() => "waiting");
  }

  /** Starts progress rendering and owns the cursor only in human TTY mode. */
  start(): void {
    this.startedAt = Date.now();
    if (this.tty) {
      this.stream.write("\u001b[?25l");
      this.redraw();
    }
  }

  /** Marks one job active and schedules a bounded redraw. */
  onStart(job: EvaluationJob, workerId: number): void {
    this.statuses[job.sequence] = "running";
    this.workerBySequence.set(job.sequence, workerId);
    if (this.tty) {
      this.startSpinner();
      this.requestRedraw();
    } else {
      this.stream.write(
        `START ${elementProgressLabel({
          id: job.element_id,
          label: job.element_label,
          implementation: job.implementation,
        })} :: ${job.input.source_file} :: ${job.input.id} :: sample=${job.sample + 1}\n`,
      );
    }
  }

  /** Marks one job settled and schedules a bounded redraw/completion event. */
  onComplete<Value>(outcome: EvaluationJobOutcome<Value>): void {
    const passed = outcome.status === "fulfilled" &&
      !(outcome.value && typeof outcome.value === "object" &&
        (("failed" in outcome.value &&
          (outcome.value as { failed?: unknown }).failed === true) ||
          ("cancelled" in outcome.value &&
            (outcome.value as { cancelled?: unknown }).cancelled === true)));
    this.statuses[outcome.job.sequence] = passed ? "passed" : "failed";
    this.workerBySequence.delete(outcome.job.sequence);
    if (this.tty) {
      if (!this.snapshot().some(state => state.running > 0)) {
        this.stopSpinner();
      }
      this.requestRedraw();
    } else {
      this.stream.write(
        `${passed ? "PASS" : "FAIL"} ${elementProgressLabel({
          id: outcome.job.element_id,
          label: outcome.job.element_label,
          implementation: outcome.job.implementation,
        })} :: ${outcome.job.input.source_file} :: ${outcome.job.input.id} :: sample=${outcome.job.sample + 1}\n`,
      );
    }
  }

  /** Returns numeric state in taxonomy order. */
  snapshot(): ElementDashboardSnapshot[] {
    return this.options.elementOrder.map(elementId => {
      const jobs = this.options.jobs.filter(job => job.element_id === elementId);
      const first = jobs[0];
      const activeJobs = jobs
        .filter(job => this.statuses[job.sequence] === "running")
        .sort((left, right) => left.sequence - right.sequence);
      const pass = jobs.filter(job =>
        this.statuses[job.sequence] === "passed"
      ).length;
      const fail = jobs.filter(job =>
        this.statuses[job.sequence] === "failed"
      ).length;
      const running = activeJobs.length;
      const done = pass + fail;
      const waiting = jobs.length - done - running;
      const active = activeJobs.length
        ? `${activeJobs[0].input.id}#${activeJobs[0].sample + 1}${
          activeJobs.length > 1 ? ` +${activeJobs.length - 1}` : ""
        }`
        : "-";
      return {
        id: elementId,
        label: first?.element_label ?? elementId,
        implementation: first?.implementation ?? "deterministic",
        total: jobs.length,
        done,
        pass,
        fail,
        running,
        waiting,
        active,
        status: running
          ? "RUN"
          : fail
            ? "FAIL"
            : done === jobs.length
              ? "PASS"
              : "WAIT",
      };
    });
  }

  /** Finalizes the dashboard and always restores the cursor. */
  finalize(): void {
    if (this.finalized) return;
    this.finalized = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.stopSpinner();
    if (this.tty) {
      this.redraw();
      this.stream.write("\u001b[?25h");
    }
  }

  /** Milliseconds elapsed since dashboard start. */
  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  /** Whether this run owns an interactive in-place terminal dashboard. */
  isInteractive(): boolean {
    return this.tty;
  }

  private requestRedraw(): void {
    if (this.finalized || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.redraw();
    }, this.throttleMs);
  }

  private startSpinner(): void {
    if (!this.tty || this.spinnerTimer || this.finalized) return;
    this.spinnerTimer = setInterval(() => {
      if (!this.snapshot().some(state => state.running > 0)) {
        this.stopSpinner();
        return;
      }
      this.requestRedraw();
    }, this.spinnerMs);
  }

  private stopSpinner(): void {
    if (!this.spinnerTimer) return;
    clearInterval(this.spinnerTimer);
    this.spinnerTimer = undefined;
  }

  private redraw(): void {
    if (!this.tty) return;
    const lines = this.renderLines();
    if (this.rendered) {
      moveCursor(this.stream, 0, -this.lineCount);
    }
    for (const line of lines) {
      clearLine(this.stream, 0);
      cursorTo(this.stream, 0);
      this.stream.write(`${line}\n`);
    }
    this.lineCount = lines.length;
    this.rendered = true;
    this.spinnerIndex++;
  }

  private renderLines(): string[] {
    const snapshots = this.snapshot();
    const width = this.stream.columns && this.stream.columns > 0
      ? this.stream.columns
      : 100;
    const title = this.options.style.title("Taxonome eval".slice(0, width));
    const fullContext =
      `${this.options.taxonomyId} v${this.options.taxonomyVersion} • split: ${this.options.split} • ${snapshots.length} elements • concurrency: ${this.options.concurrency}`;
    const compactSuffix =
      ` v${this.options.taxonomyVersion} s:${this.options.split} e:${snapshots.length} c:${this.options.concurrency}`;
    const compactIdWidth = Math.max(0, width - compactSuffix.length);
    const compactContext = compactIdWidth > 0
      ? `${truncate(this.options.taxonomyId, compactIdWidth)}${compactSuffix}`
      : `s:${this.options.split} e:${snapshots.length} c:${this.options.concurrency}`;
    const contextText = fullContext.length <= width
      ? fullContext
      : compactContext;
    const context = this.options.style.dim(contextText.slice(0, width));
    const compact = width < 90;
    const statusWidth = compact ? 4 : 6;
    const typeWidth = compact ? 4 : 7;
    const countWidth = compact ? 2 : 4;
    const countHeaders = ["DONE", "PASS", "FAIL", "RUN", "WAIT"];
    const countHeader = countHeaders.map(label =>
      compact ? label[0].padStart(countWidth) : label.padStart(countWidth)
    ).join(" ");
    const activeHeader = "ACTIVE";
    const reserved =
      statusWidth + 1 + typeWidth + 1 + countHeader.length + 1 +
      activeHeader.length + 1;
    const elementWidth = compact
      ? Math.max(8, Math.min(18, width - reserved - 8))
      : 30;
    const fixedWidth =
      statusWidth + 1 + typeWidth + 1 + elementWidth + 1 +
      countHeader.length + 1;
    const activeWidth = Math.max(1, width - fixedWidth);
    const header = [
      (compact ? "ST" : "STATUS").padEnd(statusWidth),
      "TYPE".padEnd(typeWidth),
      "ELEMENT".padEnd(elementWidth),
      countHeader,
      activeHeader.slice(0, activeWidth),
    ].join(" ");
    const lines = [
      title,
      context,
      this.options.style.label(header),
    ];

    for (const state of snapshots) {
      const statusText = state.status === "RUN"
        ? `RUN${"|/-\\"[this.spinnerIndex % 4]}`
        : state.status;
      const status = state.status === "PASS"
        ? this.options.style.pass(statusText.padEnd(statusWidth))
        : state.status === "FAIL"
          ? this.options.style.fail(statusText.padEnd(statusWidth))
          : state.status === "RUN"
            ? this.options.style.command(statusText.padEnd(statusWidth))
            : this.options.style.dim(statusText.padEnd(statusWidth));
      const typeText = state.implementation === "prompt"
        ? (compact ? "P" : "Prompt")
        : (compact ? "C" : "Code");
      const type = state.implementation === "prompt"
        ? this.options.style.prompt(typeText.padEnd(typeWidth))
        : this.options.style.code(typeText.padEnd(typeWidth));
      const fixed = truncate(
        `${state.label} (${state.id})`,
        elementWidth,
      ).padEnd(elementWidth);
      const countValues = [
        compactCount(state.done, countWidth),
        compactCount(state.pass, countWidth),
        compactCount(state.fail, countWidth),
        compactCount(state.running, countWidth),
        compactCount(state.waiting, countWidth),
      ];
      const counts = [
        this.options.style.label(countValues[0]),
        this.options.style.pass(countValues[1]),
        this.options.style.fail(countValues[2]),
        this.options.style.command(countValues[3]),
        this.options.style.dim(countValues[4]),
      ].join(" ");
      const active = truncate(state.active, activeWidth);
      lines.push(`${status} ${type} ${fixed} ${counts} ${active}`);
    }

    const total = snapshots.reduce((sum, state) => sum + state.total, 0);
    const pass = snapshots.reduce((sum, state) => sum + state.pass, 0);
    const fail = snapshots.reduce((sum, state) => sum + state.fail, 0);
    const running = snapshots.reduce((sum, state) => sum + state.running, 0);
    const waiting = snapshots.reduce((sum, state) => sum + state.waiting, 0);
    const overallFull = [
      this.options.style.label("OVERALL"),
      this.options.style.label(`complete=${pass + fail}/${total}`),
      this.options.style.pass(`pass=${pass}`),
      this.options.style.fail(`fail=${fail}`),
      this.options.style.command(`running=${running}`),
      this.options.style.dim(`waiting=${waiting}`),
    ].join(" ");
    const overallCompact = [
      this.options.style.label("ALL"),
      this.options.style.label(`C:${pass + fail}/${total}`),
      this.options.style.pass(`P:${pass}`),
      this.options.style.fail(`F:${fail}`),
      this.options.style.command(`R:${running}`),
      this.options.style.dim(`W:${waiting}`),
    ].join(" ");
    lines.push(
      dashboardVisibleWidth(overallFull) <= width
        ? overallFull
        : overallCompact,
    );
    return lines;
  }
}

/** Visible terminal width excluding ANSI control sequences. */
export function dashboardVisibleWidth(text: string): number {
  return [...stripVTControlCharacters(text)].length;
}

/** Truncates one visible plain-text field with an ellipsis. */
function truncate(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= 1) return text.slice(0, width);
  return `${text.slice(0, width - 1)}…`;
}

/** Keeps numeric cells fixed width while retaining least-significant digits. */
function compactCount(value: number, width: number): string {
  const text = String(value);
  return text.length <= width
    ? text.padStart(width)
    : text.slice(-width);
}
