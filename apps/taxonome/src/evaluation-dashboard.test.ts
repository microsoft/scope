// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvaluationInput } from "taxonomy-engine/evaluation-inputs";
import { createAtifProvenance } from "taxonomy-engine";
import type { EvaluationJob } from "./evaluation-jobs.js";
import {
  dashboardVisibleWidth,
  EvaluationDashboard,
} from "./evaluation-dashboard.js";
import { createTaxonomeStyle } from "./style.js";

afterEach(() => {
  vi.useRealTimers();
});

function input(id: string): EvaluationInput {
  return {
    id,
    family: `family-${id}`,
    originating_run: `run-${id}`,
    split: "test",
    provenance: "dashboard fixture",
    elements: ["prompt", "code"],
    source_file: "fixtures/dashboard-inputs.jsonl",
    source_line: 1,
    atif_provenance: createAtifProvenance(
      { file: "fixture.jsonl", jsonl_line: 1 },
      "$.atif",
      "ATIF-v1.8",
    ),
    atif: {
      schema_version: "ATIF-v1.8",
      session_id: `session-${id}`,
      agent: { name: "fixture", version: "1.0.0" },
      steps: [{ step_id: 1, source: "user", message: "Test." }],
      extra: {
        scope: {
          schema_version: "scope.atif-extension.v1",
          trajectory_state: "complete",
          available_sources: [],
        },
      },
    },
  };
}

function jobs(): EvaluationJob[] {
  return [
    {
      sequence: 0,
      sample: 0,
      input: input("a-very-long-input-identifier"),
      element_id: "prompt",
      element_label: "Prompt Element",
      implementation: "prompt",
    },
    {
      sequence: 1,
      sample: 0,
      input: input("second"),
      element_id: "prompt",
      element_label: "Prompt Element",
      implementation: "prompt",
    },
    {
      sequence: 2,
      sample: 0,
      input: input("third"),
      element_id: "code",
      element_label: "Code Element",
      implementation: "deterministic",
    },
  ];
}

function stream(tty: boolean, columns = 100) {
  const output = new PassThrough() as PassThrough & {
    isTTY?: boolean;
    columns?: number;
  };
  output.isTTY = tty;
  output.columns = columns;
  let text = "";
  output.on("data", chunk => {
    text += chunk.toString();
  });
  return { output, text: () => text };
}

describe("evaluation dashboard", () => {
  it("tracks fixed numeric rows, active +N, and stable taxonomy order", () => {
    const target = stream(false);
    const dashboard = new EvaluationDashboard({
      jobs: jobs(),
      elementOrder: ["prompt", "code"],
      taxonomyId: "ax-taxonomy",
      taxonomyVersion: "1.0.0",
      split: "test",
      concurrency: 2,
      style: createTaxonomeStyle(target.output, {}),
      stream: target.output,
    });
    dashboard.onStart(jobs()[1], 1);
    dashboard.onStart(jobs()[0], 0);
    const [prompt, code] = dashboard.snapshot();

    expect(prompt).toMatchObject({
      id: "prompt",
      total: 2,
      done: 0,
      pass: 0,
      fail: 0,
      running: 2,
      waiting: 0,
      active: "a-very-long-input-identifier#1 +1",
      status: "RUN",
    });
    expect(code).toMatchObject({
      id: "code",
      total: 1,
      waiting: 1,
      status: "WAIT",
    });

    dashboard.onComplete({
      job: jobs()[0],
      worker_id: 0,
      status: "fulfilled",
      value: { failed: true },
    });
    expect(dashboard.snapshot()[0]).toMatchObject({
      fail: 1,
      running: 1,
      status: "RUN",
    });
  });

  it("throttles TTY redraws, truncates, colors semantics, and restores cursor", () => {
    vi.useFakeTimers();
    const target = stream(true, 100);
    const style = createTaxonomeStyle(target.output, {});
    const planned = jobs();
    const dashboard = new EvaluationDashboard({
      jobs: planned,
      elementOrder: ["prompt", "code"],
      taxonomyId: "ax-taxonomy",
      taxonomyVersion: "1.0.0",
      split: "test",
      concurrency: 2,
      style,
      stream: target.output,
      throttleMs: 50,
      spinnerMs: 80,
    });

    dashboard.start();
    dashboard.onStart(planned[0], 0);
    dashboard.onStart(planned[1], 1);
    expect(vi.getTimerCount()).toBe(2);
    vi.advanceTimersByTime(50);
    expect(target.text()).toContain("RUN/");
    const afterFirstRunningFrame = target.text();
    vi.advanceTimersByTime(130);
    expect(target.text()).not.toBe(afterFirstRunningFrame);
    expect(target.text()).toContain("RUN-");
    dashboard.onComplete({
      job: planned[0],
      worker_id: 0,
      status: "fulfilled",
      value: { failed: true },
    });
    dashboard.finalize();

    const text = target.text();
    expect(text).toContain("Taxonome eval");
    expect(text).toContain(
      "ax-taxonomy v1.0.0 • split: test • 2 elements • concurrency: 2",
    );
    expect(text).toContain("\u001b[?25l");
    expect(text).toContain("\u001b[?25h");
    expect(text).toContain("\u001b[35m");
    expect(text).toContain("\u001b[34m");
    expect(text).toContain("\u001b[36m");
    expect(text).toContain("\u001b[32m");
    expect(text).toContain("\u001b[31m");
    expect(text).toContain("\u001b[90m");
    expect(text).toMatch(/DONE\s+PASS\s+FAIL\s+RUN\s+WAIT\s+ACTIVE/);
    expect(text).toContain("…");
    expect((text.match(/\u001b\[\?25l/g) ?? [])).toHaveLength(1);
    expect((text.match(/\u001b\[\?25h/g) ?? [])).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    for (const line of text.split("\n").filter(line =>
      dashboardVisibleWidth(line) > 0
    )) {
      expect(dashboardVisibleWidth(line)).toBeLessThanOrEqual(100);
    }
  });

  it("uses a compact non-wrapping layout at 60 columns", () => {
    const target = stream(true, 60);
    const dashboard = new EvaluationDashboard({
      jobs: jobs(),
      elementOrder: ["prompt", "code"],
      taxonomyId: "example-taxonomy-with-a-long-name",
      taxonomyVersion: "1.0.0",
      split: "test",
      concurrency: 12,
      style: createTaxonomeStyle(target.output, { NO_COLOR: "1" }),
      stream: target.output,
      throttleMs: 0,
    });
    dashboard.start();
    dashboard.finalize();

    const lines = target.text().split("\n").filter(line =>
      dashboardVisibleWidth(line) > 0
    );
    expect(lines).toHaveLength(12);
    expect(lines.some(line => line.includes("Taxonome eval"))).toBe(true);
    expect(lines.some(line =>
      line.includes("s:test") && line.includes("e:2") && line.includes("c:12")
    )).toBe(true);
    expect(lines.some(line => line.includes("ST") && line.includes("P") &&
      line.includes("F") && line.includes("R") && line.includes("W")))
      .toBe(true);
    for (const line of lines) {
      expect(dashboardVisibleWidth(line)).toBeLessThanOrEqual(60);
    }
    expect((target.text().match(/\u001b\[\?25l/g) ?? [])).toHaveLength(1);
    expect((target.text().match(/\u001b\[\?25h/g) ?? [])).toHaveLength(1);
  });

  it("keeps NO_COLOR TTY in-place but JSON/non-TTY append-only and control-free", () => {
    const planned = jobs();
    const noColorTarget = stream(true);
    const noColor = new EvaluationDashboard({
      jobs: planned,
      elementOrder: ["prompt", "code"],
      taxonomyId: "ax-taxonomy",
      taxonomyVersion: "1.0.0",
      split: "test",
      concurrency: 2,
      style: createTaxonomeStyle(noColorTarget.output, { NO_COLOR: "1" }),
      stream: noColorTarget.output,
      throttleMs: 0,
    });
    noColor.start();
    noColor.finalize();
    expect(noColorTarget.text()).toContain("\u001b[?25l");
    expect(noColorTarget.text()).not.toMatch(/\u001b\[(?:3[1-6]|9[0-7])m/);

    const jsonTarget = stream(true);
    const json = new EvaluationDashboard({
      jobs: planned,
      elementOrder: ["prompt", "code"],
      taxonomyId: "ax-taxonomy",
      taxonomyVersion: "1.0.0",
      split: "test",
      concurrency: 2,
      style: createTaxonomeStyle(jsonTarget.output, { FORCE_COLOR: "1" }),
      stream: jsonTarget.output,
      json: true,
    });
    json.start();
    json.onStart(planned[0], 0);
    json.onComplete({
      job: planned[0],
      worker_id: 0,
      status: "fulfilled",
      value: { failed: false },
    });
    json.finalize();
    expect(jsonTarget.text()).toContain("START Prompt");
    expect(jsonTarget.text()).not.toMatch(/\u001b\[/);

    const plainTarget = stream(false);
    const plain = new EvaluationDashboard({
      jobs: planned,
      elementOrder: ["prompt", "code"],
      taxonomyId: "ax-taxonomy",
      taxonomyVersion: "1.0.0",
      split: "test",
      concurrency: 2,
      style: createTaxonomeStyle(plainTarget.output, {}),
      stream: plainTarget.output,
    });
    plain.onStart(planned[2], 0);
    plain.onComplete({
      job: planned[2],
      worker_id: 0,
      status: "fulfilled",
      value: { failed: false },
    });
    expect(plainTarget.text()).toContain("START Code/Deterministic");
    expect(plainTarget.text()).toContain("PASS Code/Deterministic");
    expect(plainTarget.text()).not.toMatch(/\u001b\[/);
  });
});
