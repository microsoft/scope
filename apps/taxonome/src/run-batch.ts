// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  clearLine,
  cursorTo,
  moveCursor,
} from "node:readline";
import {
  redactErrorText,
  taxonomyRunResultSchema,
  type ArchiveScanProgress,
  AtifIngestionError,
  ATIF_INGESTION_POLICY_HASH,
  type AtifIngestionDiagnostic,
  type AtifInputKind,
  type AtifInputOrigin,
  type AtifProvenance,
  type Evaluation,
  type NormalizedTaxonomy,
  type ScopeAtif,
} from "taxonomy-engine";
import { validateAssessment } from "taxonomy-engine";
import { createInputIdentity } from "taxonomy-engine";
import { dashboardVisibleWidth } from "./evaluation-dashboard.js";
import { elementProgressLabel } from "./evaluation-progress.js";
import type { TaxonomeStyle } from "./style.js";

export const BATCH_ERROR_SCHEMA_VERSION = "scope/taxonome-run-error/v1";

export interface RunBatchSource {
  root: string;
  /** Explicit loader-owned plain/archive discriminator. */
  inputKind?: AtifInputKind;
  /** Readable dashboard label; does not participate in compatibility. */
  label?: string;
  fingerprint: string;
  /** Exact selected-file/archive-root identity for list-mode batches. */
  origin?: AtifInputOrigin;
  requestId?: string;
  runId?: string;
  atif?: ScopeAtif;
  provenance?: AtifProvenance;
  error?: Error;
}

export interface RunBatchCompatibility {
  taxonomy: NormalizedTaxonomy;
  taxonomy_digest: string;
  element_ids: string[];
  model: string;
  element_override_hashes: Record<string, string>;
  atif_ingestion_policy_hash: string;
}

export interface RunBatchMetadata {
  taxonomy: { id: string; version: string; digest: string };
  model: string;
  element_override_hashes: Record<string, string>;
  atif_ingestion_policy_hash: string;
  element_ids: string[];
  source: {
    archive_root?: string;
    input_origin?: AtifInputOrigin;
    retained_evidence_sha256: string;
    request_id?: string;
    run_id?: string;
    atif_provenance?: AtifProvenance;
  };
  initialized: boolean;
}

export interface RunBatchSuccess {
  run: {
    id: string;
    scenario: { id: string; label: string; task?: string };
    profile: { id: string; label: string };
  };
  results: Evaluation[];
  metadata: RunBatchMetadata;
}

export interface RunBatchError {
  schema_version: typeof BATCH_ERROR_SCHEMA_VERSION;
  root: string;
  request_id?: string;
  run_id?: string;
  stage: "parse" | "evaluation" | "cleanup" | "cancelled";
  error: string;
  atif_diagnostic?: AtifIngestionDiagnostic;
  atif_provenance?: AtifProvenance;
  input_origin?: AtifInputOrigin;
}

export interface RunBatchJob extends RunBatchSource {
  sequence: number;
  outputPath: string;
}

export interface RunBatchSummary {
  evaluated: number;
  resumed: number;
  failed: number;
  cancelled: number;
  total: number;
}

/** Returns the actual archive root without overloading the plain-input sentinel. */
export function runBatchArchiveRoot(
  source: Pick<RunBatchSource, "inputKind" | "origin" | "root">,
): string | undefined {
  if (source.origin) return source.origin.archive_root;
  if (source.inputKind === "archive") return source.root;
  if (source.inputKind === "plain") return undefined;
  return source.root !== "input" ? source.root : undefined;
}

/** One sequential element step can return a value and/or an authored failure. */
export interface SequentialElementResult<Value> {
  value?: Value;
  failure?: string;
}

/** Stable result of one run's taxonomy-ordered element sequence. */
export interface SequentialElementSequence<Value> {
  values: Value[];
  failures: string[];
  cancelled: boolean;
}

/** Executes selected elements one at a time and continues after safe failures. */
export async function runElementsSequentially<Value>(
  elements: readonly RunBatchElement[],
  execute: (
    element: RunBatchElement,
  ) => Promise<SequentialElementResult<Value>>,
  hooks: {
    onStart(element: RunBatchElement): void;
    onComplete(
      element: RunBatchElement,
      outcome: "done" | "error" | "cancelled",
    ): void;
  },
  signal?: AbortSignal,
): Promise<SequentialElementSequence<Value>> {
  const values: Value[] = [];
  const failures: string[] = [];
  for (const element of elements) {
    if (signal?.aborted) break;
    hooks.onStart(element);
    try {
      const result = await execute(element);
      if (result.value !== undefined) values.push(result.value);
      if (result.failure) failures.push(result.failure);
      hooks.onComplete(element, result.failure ? "error" : "done");
    } catch (error) {
      if (signal?.aborted) {
        hooks.onComplete(element, "cancelled");
        break;
      }
      failures.push(
        `${element.label} (${element.id}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      hooks.onComplete(element, "error");
    }
  }
  return {
    values,
    failures,
    cancelled: signal?.aborted ?? false,
  };
}

type DashboardStream = NodeJS.WritableStream & {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
};

type RunStatus =
  | "waiting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "resumed";

/** One taxonomy-ordered selected element shown in run progress. */
export interface RunBatchElement {
  id: string;
  label: string;
  implementation: "prompt" | "deterministic";
}

/** Stable run row planned from one archive root. */
export interface RunBatchDashboardRow {
  sequence: number;
  root: string;
  requestId?: string;
  runId?: string;
  initialStatus: "waiting" | "failed" | "resumed";
}

/** Numeric run state exposed for rendering and tests. */
export interface RunBatchRowSnapshot {
  sequence: number;
  root: string;
  identity: string;
  status: RunStatus;
  done: number;
  running: number;
  waiting: number;
  active: string;
}

/** Construction options for run-centric progress. */
export interface RunBatchDashboardOptions {
  taxonomy: { id: string; version: string };
  concurrency: number;
  elements: readonly RunBatchElement[];
  rows: readonly RunBatchDashboardRow[];
  style: TaxonomeStyle;
  stream?: DashboardStream;
  json?: boolean;
  throttleMs?: number;
  spinnerMs?: number;
}

interface MutableRunState {
  status: RunStatus;
  done: number;
  activeElement?: RunBatchElement;
}

/** Tracks one stable archive-order row per run with viewport-aware rendering. */
export class RunBatchDashboard {
  private readonly stream: DashboardStream;
  private readonly tty: boolean;
  private readonly json: boolean;
  private readonly states: MutableRunState[];
  private readonly throttleMs: number;
  private readonly spinnerMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private spinnerTimer: ReturnType<typeof setInterval> | undefined;
  private lineCount = 0;
  private rendered = false;
  private finalized = false;
  private spinnerIndex = 0;

  constructor(private readonly options: RunBatchDashboardOptions) {
    this.stream = options.stream ?? process.stderr;
    this.json = options.json ?? false;
    this.tty = this.stream.isTTY === true && !this.json;
    this.throttleMs = options.throttleMs ?? 50;
    this.spinnerMs = options.spinnerMs ?? 80;
    this.states = options.rows.map(row => ({
      status: row.initialStatus,
      done: row.initialStatus === "resumed" ? options.elements.length : 0,
    }));
  }

  /** Starts in-place rendering or one append-only batch context line. */
  start(): void {
    if (!this.tty) {
      this.stream.write(
        `BATCH ${this.options.rows.length} runs :: ${this.options.elements.length} elements :: concurrency=${this.options.concurrency}\n`,
      );
      for (const row of this.options.rows) {
        if (row.initialStatus !== "waiting") {
          this.stream.write(
            `RUN ${row.initialStatus.toUpperCase()} ${row.runId ?? row.requestId ?? row.root}\n`,
          );
        }
      }
      return;
    }
    this.stream.write("\u001b[?25l");
    this.redraw();
  }

  /** Marks a worker as owning one run. */
  startRun(sequence: number): void {
    const state = this.states[sequence];
    if (state.status === "failed" || state.status === "resumed") return;
    state.status = "running";
    if (this.tty) {
      this.startSpinner();
      this.requestRedraw();
    } else {
      this.stream.write(`RUN START ${this.identity(sequence)}\n`);
    }
  }

  /** Marks one taxonomy-ordered element active for a run. */
  startElement(sequence: number, element: RunBatchElement): void {
    const state = this.states[sequence];
    state.status = "running";
    state.activeElement = element;
    if (this.tty) {
      this.startSpinner();
      this.requestRedraw();
    } else {
      this.stream.write(
        `ELEMENT START ${this.identity(sequence)} :: ${elementProgressLabel(element)}\n`,
      );
    }
  }

  /** Settles one element while preserving one-active-element-per-run. */
  completeElement(
    sequence: number,
    element: RunBatchElement,
    outcome: "done" | "error" | "cancelled",
  ): void {
    const state = this.states[sequence];
    if (outcome !== "cancelled") state.done++;
    state.activeElement = undefined;
    if (this.tty) {
      this.requestRedraw();
    } else {
      this.stream.write(
        `ELEMENT ${outcome.toUpperCase()} ${this.identity(sequence)} :: ${elementProgressLabel(element)}\n`,
      );
    }
  }

  /** Settles one run after its output record has been published. */
  completeRun(
    sequence: number,
    status: "completed" | "failed" | "cancelled",
  ): void {
    const state = this.states[sequence];
    state.status = status;
    state.activeElement = undefined;
    if (this.tty) {
      if (!this.states.some(candidate => candidate.status === "running")) {
        this.stopSpinner();
      }
      this.requestRedraw();
    } else {
      this.stream.write(`RUN ${status.toUpperCase()} ${this.identity(sequence)}\n`);
    }
  }

  /** Returns archive-order run snapshots. */
  snapshot(): RunBatchRowSnapshot[] {
    return this.options.rows.map((row, sequence) => {
      const state = this.states[sequence];
      const running = state.activeElement ? 1 : 0;
      const waiting = state.status === "failed" ||
          state.status === "cancelled" ||
          state.status === "resumed"
        ? 0
        : Math.max(0, this.options.elements.length - state.done - running);
      return {
        sequence,
        root: row.root,
        identity: this.identity(sequence),
        status: state.status,
        done: state.done,
        running,
        waiting,
        active: state.activeElement
          ? `${state.activeElement.implementation === "prompt" ? "Prompt" : "Code"} ${state.activeElement.label}`
          : "-",
      };
    });
  }

  /** Returns stable run-level completion counts. */
  summary(): RunBatchSummary {
    const statuses = this.states.map(state => state.status);
    return {
      evaluated: statuses.filter(status => status === "completed").length,
      resumed: statuses.filter(status => status === "resumed").length,
      failed: statuses.filter(status => status === "failed").length,
      cancelled: statuses.filter(status => status === "cancelled").length,
      total: statuses.length,
    };
  }

  /** Restores terminal state and returns the final deterministic summary. */
  finalize(): RunBatchSummary {
    if (this.finalized) return this.summary();
    this.finalized = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.stopSpinner();
    if (this.tty) {
      this.redraw();
      this.stream.write("\u001b[?25h\n");
    }
    return this.summary();
  }

  /** Whether this dashboard owns an in-place TTY region. */
  isInteractive(): boolean {
    return this.tty;
  }

  private identity(sequence: number): string {
    const row = this.options.rows[sequence];
    return row.runId ?? row.requestId ?? row.root;
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
      if (!this.states.some(state => state.status === "running")) {
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
    if (this.rendered) moveCursor(this.stream, 0, -this.lineCount);
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
    const width = this.stream.columns && this.stream.columns > 0
      ? this.stream.columns
      : 100;
    const snapshots = this.visibleSnapshots();
    const totalSnapshots = this.snapshot();
    const hidden = totalSnapshots.length - snapshots.length;
    const compact = width < 88;
    const statusWidth = compact ? 5 : 9;
    const identityWidth = compact
      ? Math.max(8, Math.min(18, Math.floor(width * 0.28)))
      : Math.max(12, Math.min(36, Math.floor(width * 0.34)));
    const countWidth = compact ? 2 : 4;
    const countsHeader = compact
      ? ["D", "R", "W"].map(value => value.padStart(countWidth)).join(" ")
      : ["DONE", "RUN", "WAIT"].map(value => value.padStart(countWidth)).join(" ");
    const fixedWidth = statusWidth + 1 + identityWidth + 1 + countsHeader.length + 1;
    const activeWidth = Math.max(1, width - fixedWidth);
    const title = this.options.style.title(truncate("Taxonome run", width));
    const fullContext =
      `${this.options.taxonomy.id} v${this.options.taxonomy.version} • ${totalSnapshots.length} runs • ${this.options.elements.length} elements • concurrency: ${this.options.concurrency}`;
    const compactContext =
      `${truncate(this.options.taxonomy.id, Math.max(1, width - 28))} v${this.options.taxonomy.version} r:${totalSnapshots.length} e:${this.options.elements.length} c:${this.options.concurrency}`;
    const contextText = fullContext.length <= width ? fullContext : compactContext;
    const header = [
      (compact ? "ST" : "STATUS").padEnd(statusWidth),
      "RUN".padEnd(identityWidth),
      countsHeader,
      "ACTIVE".slice(0, activeWidth),
    ].join(" ");
    const lines = [
      title,
      this.options.style.dim(truncate(contextText, width)),
      this.options.style.label(header),
    ];

    for (const snapshot of snapshots) {
      const statusText = snapshot.status === "running"
        ? `RUN${"⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[this.spinnerIndex % 10]}`
        : snapshot.status === "completed"
          ? "DONE"
          : compact
            ? {
              waiting: "WAIT",
              failed: "FAIL",
              cancelled: "CANC",
              resumed: "RESUM",
              running: "RUN",
              completed: "DONE",
            }[snapshot.status]
            : snapshot.status.toUpperCase();
      const paddedStatus = truncate(statusText, statusWidth).padEnd(statusWidth);
      const status = snapshot.status === "running"
        ? this.options.style.command(paddedStatus)
        : snapshot.status === "resumed"
          ? this.options.style.code(paddedStatus)
          : snapshot.status === "completed"
            ? this.options.style.pass(paddedStatus)
            : snapshot.status === "failed" || snapshot.status === "cancelled"
              ? this.options.style.fail(paddedStatus)
              : this.options.style.dim(paddedStatus);
      const counts = [
        this.options.style.label(compactCount(snapshot.done, countWidth)),
        this.options.style.command(compactCount(snapshot.running, countWidth)),
        this.options.style.dim(compactCount(snapshot.waiting, countWidth)),
      ].join(" ");
      const identity = truncate(snapshot.identity, identityWidth).padEnd(identityWidth);
      const active = snapshot.status === "waiting"
        ? this.options.style.dim(truncate(snapshot.active, activeWidth))
        : truncate(snapshot.active, activeWidth);
      lines.push(`${status} ${identity} ${counts} ${active}`);
    }
    if (hidden > 0) {
      lines.push(this.options.style.dim(truncate(`… ${hidden} hidden`, width)));
    }
    const summary = this.summary();
    const running = this.states.filter(state => state.status === "running").length;
    const waiting = this.states.filter(state => state.status === "waiting").length;
    const overall = `Runs ${summary.evaluated} done • ${summary.resumed} resumed • ${summary.failed} failed • ${summary.cancelled} cancelled • ${running} running • ${waiting} waiting`;
    lines.push(truncate(overall, width));
    return lines;
  }

  private visibleSnapshots(): RunBatchRowSnapshot[] {
    const snapshots = this.snapshot();
    const viewportRows = this.stream.rows && this.stream.rows > 0
      ? this.stream.rows
      : snapshots.length + 5;
    const budget = Math.max(1, viewportRows - 5);
    if (snapshots.length <= budget) return snapshots;

    const priority = snapshots.filter(snapshot =>
      snapshot.status === "running" ||
      snapshot.status === "failed" ||
      snapshot.status === "cancelled"
    );
    const selected = new Set(priority.map(snapshot => snapshot.sequence));
    const activeSequences = priority
      .filter(snapshot => snapshot.status === "running")
      .map(snapshot => snapshot.sequence);
    const center = activeSequences[0] ?? priority[0]?.sequence ?? 0;
    const candidates = snapshots
      .filter(snapshot => !selected.has(snapshot.sequence))
      .sort((left, right) =>
        Math.abs(left.sequence - center) - Math.abs(right.sequence - center) ||
        left.sequence - right.sequence
      );
    const rowBudget = Math.max(priority.length, budget - 1);
    for (const candidate of candidates) {
      if (selected.size >= rowBudget) break;
      selected.add(candidate.sequence);
    }
    return snapshots.filter(snapshot => selected.has(snapshot.sequence));
  }
}

/** Throttled scanner progress that owns exactly one TTY line. */
export class ArchiveScanProgressRenderer {
  private readonly tty: boolean;
  private readonly throttleMs: number;
  private readonly spinnerMs: number;
  private latest: ArchiveScanProgress | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private spinnerTimer: ReturnType<typeof setInterval> | undefined;
  private spinnerIndex = 0;
  private started = false;
  private finalized = false;
  private lastPercent = -1;
  private lastCompressedMilestone = 0;
  private lastRootMilestone = 0;

  constructor(
    private readonly stream: DashboardStream = process.stderr,
    private readonly style: TaxonomeStyle,
    private readonly json = false,
    options: { throttleMs?: number; spinnerMs?: number } = {},
  ) {
    this.tty = stream.isTTY === true && !json;
    this.throttleMs = options.throttleMs ?? 50;
    this.spinnerMs = options.spinnerMs ?? 80;
  }

  /** Receives monotonic scanner snapshots. */
  update(progress: ArchiveScanProgress): void {
    if (this.finalized) return;
    this.latest = progress;
    if (!this.started) {
      this.started = true;
      if (this.tty) {
        this.stream.write("\u001b[?25l");
        this.startSpinner();
        this.redraw();
      } else {
        this.stream.write("SCAN START Scope archive\n");
      }
    }
    if (this.tty) {
      this.requestRedraw();
    } else {
      this.appendMilestone(progress);
    }
  }

  /** Finishes the scan line and restores cursor state on every exit path. */
  finalize(outcome: "complete" | "error" | "cancelled"): void {
    if (this.finalized) return;
    this.finalized = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.stopSpinner();
    if (!this.started) return;
    if (this.tty) {
      clearLine(this.stream, 0);
      cursorTo(this.stream, 0);
      const progress = this.latest ? formatScanProgress(this.latest) : "no progress";
      const text = `${outcome === "complete" ? "DONE" : outcome.toUpperCase()} Scanning archive • ${progress}`;
      const width = this.stream.columns && this.stream.columns > 0
        ? this.stream.columns
        : 100;
      const truncated = truncate(text, width);
      const rendered = outcome === "complete"
        ? this.style.pass(truncated)
        : this.style.fail(truncated);
      this.stream.write(rendered);
      this.stream.write("\u001b[?25h\n");
    } else {
      const progress = this.latest;
      this.stream.write(
        `SCAN ${outcome.toUpperCase()}${progress ? ` :: ${formatScanProgress(progress)}` : ""}\n`,
      );
    }
  }

  private appendMilestone(progress: ArchiveScanProgress): void {
    if (progress.complete) return;
    const percent = scanPercent(progress);
    const compressedMilestone = Math.floor(progress.compressedBytes / (16 * 1024 * 1024));
    const rootMilestone = (progress.rootCount === 1 && this.lastRootMilestone === 0) ||
      progress.rootCount >= this.lastRootMilestone + 10;
    if (
      (percent !== undefined && percent >= this.lastPercent + 10) ||
      compressedMilestone > this.lastCompressedMilestone ||
      rootMilestone
    ) {
      if (percent !== undefined) this.lastPercent = Math.floor(percent / 10) * 10;
      this.lastCompressedMilestone = compressedMilestone;
      this.lastRootMilestone = progress.rootCount;
      this.stream.write(`SCAN ${formatScanProgress(progress)}\n`);
    }
  }

  private requestRedraw(): void {
    if (this.finalized || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.redraw();
    }, this.throttleMs);
  }

  private startSpinner(): void {
    if (this.spinnerTimer) return;
    this.spinnerTimer = setInterval(() => {
      this.requestRedraw();
    }, this.spinnerMs);
  }

  private stopSpinner(): void {
    if (!this.spinnerTimer) return;
    clearInterval(this.spinnerTimer);
    this.spinnerTimer = undefined;
  }

  private redraw(): void {
    if (!this.tty || !this.latest) return;
    const width = this.stream.columns && this.stream.columns > 0
      ? this.stream.columns
      : 100;
    clearLine(this.stream, 0);
    cursorTo(this.stream, 0);
    const spinner = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[this.spinnerIndex++ % 10];
    const text = `${spinner} Scanning archive • ${formatScanProgress(this.latest)}`;
    this.stream.write(this.style.command(truncate(text, width)));
  }
}

/** Converts scanner counters to a stable, compact human line. */
export function formatScanProgress(progress: ArchiveScanProgress): string {
  const percent = scanPercent(progress);
  const compressed = progress.compressedTotalBytes === undefined
    ? formatBytes(progress.compressedBytes)
    : `${formatBytes(progress.compressedBytes)}/${formatBytes(progress.compressedTotalBytes)}`;
  return `${compressed}${percent === undefined ? "" : ` (${percent.toFixed(0)}%)`} • ${progress.entryCount} entries • ${progress.rootCount} roots • ${formatBytes(progress.streamedBytes)} streamed • ${formatBytes(progress.retainedBytes)} retained`;
}

function scanPercent(progress: ArchiveScanProgress): number | undefined {
  if (!progress.compressedTotalBytes) return undefined;
  return Math.min(100, progress.compressedBytes / progress.compressedTotalBytes * 100);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function truncate(text: string, width: number): string {
  if (dashboardVisibleWidth(text) <= width) return text;
  if (width <= 1) return text.slice(0, width);
  return `${text.slice(0, width - 1)}…`;
}

function compactCount(value: number, width: number): string {
  const text = String(value);
  return text.length <= width ? text.padStart(width) : text.slice(-width);
}

const safeSegment = (value: string) =>
  value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";

/** Derives a stable output filename from manifest identity or archive root. */
export function runBatchFilename(source: RunBatchSource): string {
  if (source.origin) {
    const input = safeSegment(
      basename(source.origin.selected_input)
        .replace(/\.(?:tar\.gz|json)$/i, ""),
    );
    const root = source.origin.archive_root
      ? `--${safeSegment(source.origin.archive_root)}`
      : "";
    const suffix = createHash("sha256")
      .update(JSON.stringify(source.origin))
      .digest("hex")
      .slice(0, 12);
    return `${input}${root}--${suffix}.json`;
  }
  if (source.requestId && source.runId) {
    return `${safeSegment(source.requestId)}--${safeSegment(source.runId)}.json`;
  }
  const root = safeSegment(basename(source.root));
  const suffix = createHash("sha256").update(source.root).digest("hex").slice(0, 12);
  return `${root || "root"}--${suffix}.json`;
}

/** Removes credentials and absolute paths from one persisted error message. */
export function redactRunBatchError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactErrorText(message)
    .replace(/(?:[A-Za-z]:)?[/\\][^\s'"]+/g, "[redacted-path]")
    .slice(0, 2000);
}

/** Preserves bounded structured ATIF locations without raw invalid input. */
export function runBatchAtifDiagnostic(
  error: unknown,
): AtifIngestionDiagnostic | undefined {
  return error instanceof AtifIngestionError
    ? structuredClone(error.diagnostic)
    : undefined;
}

/** Writes one complete JSON record atomically, replacing only after validation. */
export async function writeRunBatchRecordAtomic(
  outputPath: string,
  value: RunBatchSuccess | RunBatchError,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.part-${process.pid}-${randomUUID()}`;
  try {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    JSON.parse(text);
    await writeFile(temporary, text, { flag: "wx" });
    await rename(temporary, outputPath);
  } finally {
    await rm(temporary, { force: true });
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameRecord(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const leftEntries = Object.entries(left).sort();
  const rightEntries = Object.entries(right).sort();
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

/** Returns true only for a complete success record compatible with this invocation. */
export async function canResumeRunBatchJob(
  job: RunBatchJob,
  expected: RunBatchCompatibility,
): Promise<boolean> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(job.outputPath, "utf8")) as unknown;
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const wrapper = taxonomyRunResultSchema.safeParse(parsed);
  if (!wrapper.success) return false;
  const record = wrapper.data;
  const run = record.run;
  const metadata = record.metadata as Record<string, unknown> | undefined;
  const taxonomy = metadata?.taxonomy as Record<string, unknown> | undefined;
  const source = metadata?.source as Record<string, unknown> | undefined;
  const elementIds = metadata?.element_ids;
  const overrideHashes = metadata?.element_override_hashes;
  if (
    !metadata ||
    typeof taxonomy?.digest !== "string" ||
    (
      typeof source?.archive_root !== "string" &&
      !source?.input_origin
    ) ||
    typeof source?.retained_evidence_sha256 !== "string" ||
    !Array.isArray(elementIds) ||
    !elementIds.every(value => typeof value === "string") ||
    !overrideHashes ||
    typeof overrideHashes !== "object" ||
    Array.isArray(overrideHashes)
  ) return false;

  const evaluations = record.results;
  if (!job.atif || evaluations.some(result => result.status === "failed")) {
    return false;
  }
  const archiveRoot = runBatchArchiveRoot(job);
  const exactIdentity = createInputIdentity(job.atif, {
    ...(archiveRoot ? { archiveRoot } : {}),
    requestId: job.requestId,
    runId: job.runId,
  });
  const scope = job.atif.extra?.scope;
  const scopeRun = scope?.run;
  const actualRunId = job.runId ??
      scopeRun?.id ??
      job.atif.trajectory_id ??
      job.atif.session_id ??
      `atif-${exactIdentity.sha256.slice(0, 12)}`;
  const expectedRun = {
    id: scopedBatchRunId(actualRunId, job.origin),
    scenario: {
      id: scopeRun?.scenario_id ?? "unknown-scenario",
      label:
        scopeRun?.scenario_label ??
        scopeRun?.scenario_id ??
        "unknown-scenario",
      ...(scope?.task ? { task: scope.task } : {}),
    },
    profile: {
      id: scopeRun?.profile_id ?? "unknown-profile",
      label:
        scopeRun?.profile_label ??
        scopeRun?.profile_id ??
        "unknown-profile",
    },
  };
  const resultElementIds = evaluations.map(result => result.element.id);
  const resultDigests = evaluations.map(result => result.taxonomy.digest);
  for (const evaluation of evaluations) {
    if (
      !isDeepStrictEqual(evaluation.input, exactIdentity)
    ) return false;
    const element = expected.taxonomy.elementById.get(evaluation.element.id);
    if (
      !element ||
      evaluation.status !== "succeeded" ||
      !isDeepStrictEqual(evaluation.taxonomy, {
        id: expected.taxonomy.id,
        version: expected.taxonomy.version,
        digest: expected.taxonomy.digest,
      }) ||
      !isDeepStrictEqual(evaluation.element, {
        id: element.id,
        label: element.label,
        ...(element.category_id
          ? { category_id: element.category_id }
          : {}),
      }) ||
      !validateAssessment(
        evaluation.result,
        element.output,
        job.atif,
      ).assessment
    ) return false;
  }
  return (
    isDeepStrictEqual(run, expectedRun) &&
    (
      job.origin
        ? isDeepStrictEqual(source.input_origin, job.origin) &&
          source.archive_root === job.origin.archive_root
        : source.archive_root === runBatchArchiveRoot(job)
    ) &&
    source.retained_evidence_sha256 === job.fingerprint &&
    (!job.requestId || source.request_id === job.requestId) &&
    (!job.runId || source.run_id === job.runId) &&
    (!job.provenance ||
      isDeepStrictEqual(source.atif_provenance, job.provenance)) &&
    isDeepStrictEqual(taxonomy, {
      id: expected.taxonomy.id,
      version: expected.taxonomy.version,
      digest: expected.taxonomy_digest,
    }) &&
    metadata.model === expected.model &&
    metadata.atif_ingestion_policy_hash ===
      expected.atif_ingestion_policy_hash &&
    sameStrings(elementIds as string[], expected.element_ids) &&
    sameStrings(resultElementIds, expected.element_ids) &&
    resultDigests.every(digest => digest === expected.taxonomy_digest) &&
    sameRecord(
      overrideHashes as Record<string, string>,
      expected.element_override_hashes,
    )
  );
}

/** Scopes only the batch wrapper identity; ATIF/evaluation identities stay exact. */
export function scopedBatchRunId(
  runId: string,
  origin?: AtifInputOrigin,
): string {
  if (!origin) return runId;
  const suffix = createHash("sha256")
    .update(JSON.stringify(origin))
    .digest("hex")
    .slice(0, 12);
  return `${runId}--source-${suffix}`;
}

/** Plans deterministic root jobs and pre-classifies compatible resumed outputs. */
export async function planRunBatch(
  sources: readonly RunBatchSource[],
  outputDir: string,
  expected: RunBatchCompatibility,
  force: boolean,
): Promise<{ jobs: RunBatchJob[]; resumed: RunBatchJob[] }> {
  await mkdir(outputDir, { recursive: true });
  const planned = sources.map((source, sequence) => ({
    ...source,
    sequence,
    outputPath: join(outputDir, runBatchFilename(source)),
  }));
  if (force) return { jobs: planned, resumed: [] };

  const resumable = await Promise.all(planned.map(job =>
    canResumeRunBatchJob(job, expected)
  ));
  return {
    jobs: planned.filter((_, index) => !resumable[index]),
    resumed: planned.filter((_, index) => resumable[index]),
  };
}

/** Runs stable root jobs through a bounded global worker pool. */
export async function runRootJobs<T>(
  jobs: readonly RunBatchJob[],
  concurrency: number,
  execute: (job: RunBatchJob, workerId: number) => Promise<T>,
  signal?: AbortSignal,
): Promise<Array<{
  job: RunBatchJob;
  status: "fulfilled" | "rejected" | "cancelled";
  value?: T;
  error?: unknown;
}>> {
  const outcomes = new Array<{
    job: RunBatchJob;
    status: "fulfilled" | "rejected" | "cancelled";
    value?: T;
    error?: unknown;
  }>(jobs.length);
  let next = 0;

  async function worker(workerId: number): Promise<void> {
    while (!signal?.aborted) {
      const index = next++;
      const job = jobs[index];
      if (!job) return;
      try {
        outcomes[index] = {
          job,
          status: "fulfilled",
          value: await execute(job, workerId),
        };
      } catch (error) {
        outcomes[index] = {
          job,
          status: signal?.aborted ? "cancelled" : "rejected",
          error,
        };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, (_, workerId) =>
      worker(workerId)
    ),
  );
  for (let index = 0; index < jobs.length; index++) {
    outcomes[index] ??= { job: jobs[index], status: "cancelled" };
  }
  return outcomes;
}
