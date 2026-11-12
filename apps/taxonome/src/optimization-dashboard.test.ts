// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { OptimizationDashboard } from "./optimization-dashboard.js";
import { createTaxonomeStyle } from "./style.js";

describe("OptimizationDashboard", () => {
  it("uses stable colored TTY rows and restores the cursor", () => {
    const stream = new PassThrough() as PassThrough & {
      isTTY?: boolean;
    };
    stream.isTTY = true;
    let text = "";
    stream.on("data", chunk => {
      text += chunk.toString();
    });
    const dashboard = new OptimizationDashboard(
      ["prompt-a", "prompt-b"],
      ["code-a"],
      createTaxonomeStyle(stream, { FORCE_COLOR: "1" }),
      stream as never,
    );
    dashboard.start();
    dashboard.update({
      elementId: "prompt-a",
      status: "OPTIMIZING",
      train: 2,
      validation: 1,
      metricCalls: 3,
      trial: 1,
      totalTrials: 2,
      candidateCount: 4,
      latestScore: 0.5,
      bestScore: 1,
      paretoFrontSize: 2,
      detail: "candidate scored",
    });
    dashboard.update({
      elementId: "prompt-a",
      status: "DONE",
      metricCalls: 4,
      bestScore: 1,
      stopReason: "converged",
      detail: "optimized YAML ready",
    });
    dashboard.update({
      elementId: "prompt-b",
      status: "FAILED",
      detail: "transport unavailable",
    });
    dashboard.finalize();

    expect(text).toContain("\u001b[?25l");
    expect(text).toContain("\u001b[?25h");
    expect(text).toContain("deterministic…");
    expect(text).toContain("stop=converged");
    expect(text).toContain("RUN 0  DONE 1  WAIT 0  FAIL 1  SKIP 1");
    expect(text).toContain("1/2");
    expect(text).toContain("converged");
    const renderedRows = text.split("\n").filter(line =>
      line.includes("prompt-a") || line.includes("prompt-b")
    );
    expect(renderedRows.every(line =>
      line.replaceAll(/\u001b\[[0-9;]*m/g, "").length <= 79
    )).toBe(true);
    expect(text.indexOf("prompt-a")).toBeLessThan(text.indexOf("prompt-b"));
    expect(text.match(/\u001b\[2K/g)?.length).toBeGreaterThan(3);
    expect(text).toMatch(/\u001b\[/);
  });

  it("emits stable plain lines for non-TTY output", () => {
    const stream = new PassThrough();
    let text = "";
    stream.on("data", chunk => {
      text += chunk.toString();
    });
    const dashboard = new OptimizationDashboard(
      ["prompt-a"],
      [],
      createTaxonomeStyle(stream, { NO_COLOR: "1" }),
      stream as never,
    );
    dashboard.start();
    dashboard.update({
      elementId: "prompt-a",
      status: "PREFLIGHT",
      train: 2,
      validation: 1,
      trial: 1,
      totalTrials: 3,
      latestScore: 0.25,
      bestScore: 0.5,
      paretoFrontSize: 1,
      detail: "validated",
    });
    dashboard.finalize();
    expect(text).toContain("PREFLIGHT prompt-a train=2 validation=1");
    expect(text).toContain("trial=1/3");
    expect(text).toContain("latest=0.250");
    expect(text).toContain("best=0.500");
    expect(text).toContain("pareto=1");
    expect(text).not.toMatch(/\u001b\[/);
  });

  it("is silent for JSON output", () => {
    const stream = new PassThrough();
    let text = "";
    stream.on("data", chunk => {
      text += chunk.toString();
    });
    const dashboard = new OptimizationDashboard(
      ["prompt-a"],
      [],
      createTaxonomeStyle(stream, { FORCE_COLOR: "1" }),
      stream as never,
      true,
    );
    dashboard.start();
    dashboard.update({
      elementId: "prompt-a",
      status: "DONE",
      metricCalls: 2,
      bestScore: 1,
      detail: "complete",
    });
    dashboard.finalize();
    expect(text).toBe("");
  });
});
