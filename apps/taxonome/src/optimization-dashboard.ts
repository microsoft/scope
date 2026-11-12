// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { TaxonomeStyle } from "./style.js";

type ElementState = {
  id: string;
  status: "WAIT" | "PREFLIGHT" | "OPTIMIZING" | "DONE" | "FAILED" | "SKIPPED";
  train: number;
  validation: number;
  metricCalls: number;
  trial?: number;
  totalTrials?: number;
  candidateCount?: number;
  latestScore?: number;
  bestScore?: number;
  paretoFrontSize?: number;
  stopReason?: string;
  detail: string;
};

function displayNumber(value: number | undefined): string {
  if (value === undefined) return "-";
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

function displayTrial(
  trial: number | undefined,
  totalTrials: number | undefined,
): string {
  if (trial === undefined) return "-";
  return totalTrials === undefined ? String(trial) : `${trial}/${totalTrials}`;
}

function clip(value: string, width: number): string {
  return value.length <= width
    ? value
    : `${value.slice(0, Math.max(0, width - 1))}…`;
}

/** Truthful stable-row progress for multi-element optimization. */
export class OptimizationDashboard {
  private readonly interactive: boolean;
  private readonly silent: boolean;
  private readonly rows: ElementState[];
  private renderedLines = 0;
  private started = false;

  constructor(
    elementIds: readonly string[],
    deterministicIds: readonly string[],
    private readonly style: TaxonomeStyle,
    private readonly stream: NodeJS.WriteStream = process.stderr,
    json = false,
  ) {
    this.silent = json;
    this.interactive = !json && stream.isTTY === true;
    this.rows = [
      ...elementIds.map(id => ({
        id,
        status: "WAIT" as const,
        train: 0,
        validation: 0,
        metricCalls: 0,
        detail: "waiting",
      })),
      ...deterministicIds.map(id => ({
        id,
        status: "SKIPPED" as const,
        train: 0,
        validation: 0,
        metricCalls: 0,
        detail: "deterministic element",
      })),
    ];
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.silent) return;
    if (this.interactive) this.stream.write("\u001b[?25l");
    this.render();
  }

  update(input: {
    elementId: string;
    status: ElementState["status"];
    train?: number;
    validation?: number;
    metricCalls?: number;
    trial?: number;
    totalTrials?: number;
    candidateCount?: number;
    latestScore?: number;
    bestScore?: number;
    paretoFrontSize?: number;
    stopReason?: string;
    detail: string;
  }): void {
    const row = this.rows.find(candidate => candidate.id === input.elementId);
    if (!row) return;
    Object.assign(row, {
      status: input.status,
      ...(input.train !== undefined ? { train: input.train } : {}),
      ...(input.validation !== undefined ? { validation: input.validation } : {}),
      ...(input.metricCalls !== undefined ? { metricCalls: input.metricCalls } : {}),
      ...(input.trial !== undefined ? { trial: input.trial } : {}),
      ...(input.totalTrials !== undefined
        ? { totalTrials: input.totalTrials }
        : {}),
      ...(input.candidateCount !== undefined
        ? { candidateCount: input.candidateCount }
        : {}),
      ...(input.latestScore !== undefined
        ? { latestScore: input.latestScore }
        : {}),
      ...(input.bestScore !== undefined ? { bestScore: input.bestScore } : {}),
      ...(input.paretoFrontSize !== undefined
        ? { paretoFrontSize: input.paretoFrontSize }
        : {}),
      ...(input.stopReason !== undefined
        ? { stopReason: input.stopReason }
        : {}),
      detail: input.detail,
    });
    if (this.silent) return;
    if (this.interactive) this.render();
    else {
      this.stream.write(
        `${input.status} ${input.elementId} train=${row.train} validation=${row.validation} calls=${row.metricCalls}` +
        `${row.trial === undefined ? "" : ` trial=${displayTrial(row.trial, row.totalTrials)}`}` +
        `${row.candidateCount === undefined ? "" : ` candidates=${row.candidateCount}`}` +
        `${row.latestScore === undefined ? "" : ` latest=${displayNumber(row.latestScore)}`}` +
        `${row.bestScore === undefined ? "" : ` best=${displayNumber(row.bestScore)}`}` +
        `${row.paretoFrontSize === undefined ? "" : ` pareto=${row.paretoFrontSize}`}` +
        `${row.stopReason === undefined ? "" : ` stop=${row.stopReason}`} ${input.detail}\n`,
      );
    }
  }

  finalize(): void {
    if (!this.started) return;
    if (this.silent) return;
    if (this.interactive) {
      this.render();
      this.stream.write("\u001b[?25h");
    }
  }

  private render(): void {
    if (!this.interactive) return;
    if (this.renderedLines > 0) {
      this.stream.write(`\u001b[${this.renderedLines}A`);
    }
    const complete = this.rows.filter(row => row.status === "DONE").length;
    const failed = this.rows.filter(row => row.status === "FAILED").length;
    const skipped = this.rows.filter(row => row.status === "SKIPPED").length;
    const waiting = this.rows.filter(row => row.status === "WAIT").length;
    const running = this.rows.filter(row =>
      row.status === "PREFLIGHT" || row.status === "OPTIMIZING"
    ).length;
    const header =
      `Taxonome optimize  RUN ${running}  DONE ${complete}  WAIT ${waiting}` +
      `  FAIL ${failed}  SKIP ${skipped}`;
    const lines = [
      this.style.title(header),
      this.style.label(
        "STATUS     ELEMENT    TRN VAL TRIAL CAND CALL LAST BEST PAR DETAIL",
      ),
      ...this.rows.map(row => {
        const paddedStatus = row.status.padEnd(10);
        const status = row.status === "DONE"
          ? this.style.pass(paddedStatus)
          : row.status === "FAILED"
            ? this.style.fail(paddedStatus)
            : row.status === "SKIPPED"
              ? this.style.warning(paddedStatus)
              : this.style.prompt(paddedStatus);
        const detail = row.stopReason
          ? `stop=${row.stopReason}`
          : row.detail;
        return `${status} ${clip(row.id, 10).padEnd(10)} ` +
          `${String(row.train).padStart(3)} ${String(row.validation).padStart(3)} ` +
          `${displayTrial(row.trial, row.totalTrials).padStart(5)} ` +
          `${displayNumber(row.candidateCount).padStart(4)} ` +
          `${String(row.metricCalls).padStart(4)} ` +
          `${displayNumber(row.latestScore).padStart(4)} ` +
          `${displayNumber(row.bestScore).padStart(4)} ` +
          `${displayNumber(row.paretoFrontSize).padStart(3)} ` +
          this.style.dim(clip(detail, 14));
      }),
    ];
    for (const line of lines) {
      this.stream.write(`\u001b[2K${line}\n`);
    }
    this.renderedLines = lines.length;
  }
}
