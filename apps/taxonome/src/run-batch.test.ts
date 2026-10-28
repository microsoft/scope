// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { PassThrough } from "node:stream";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ATIF_INGESTION_POLICY_HASH,
  createAtifProvenance,
  createInputIdentity,
  parseScopeAtif,
  type Evaluation,
  type NormalizedTaxonomy,
} from "taxonomy-engine";
import {
  ArchiveScanProgressRenderer,
  canResumeRunBatchJob,
  formatScanProgress,
  planRunBatch,
  runBatchArchiveRoot,
  RunBatchDashboard,
  runBatchFilename,
  runElementsSequentially,
  runRootJobs,
  writeRunBatchRecordAtomic,
  type RunBatchJob,
  type RunBatchSuccess,
} from "./run-batch.js";
import { dashboardVisibleWidth } from "./evaluation-dashboard.js";
import { createTaxonomeStyle } from "./style.js";

afterEach(() => {
  vi.useRealTimers();
});

const taxonomy = {
  schema_version: "scope/taxonomy/v1",
  id: "taxonomy-a",
  version: "1.0.0",
  digest: "a".repeat(64),
  surfaces: [],
  elements: ["element-a", "element-b"].map(id => ({
    id,
    label: id,
    implementation: { type: "prompt" as const, prompt: "Test." },
    preconditions: {
      requires_recorded_discovery: false,
      requires_complete_trajectory: false,
      requires_task: false,
    },
    output: {
      evidence_roles: {
        step: {
          type: "atif.step" as const,
          description: "Optional step.",
          min: 0,
        },
      },
      constraints: [],
    },
  })),
} as unknown as NormalizedTaxonomy;
Object.assign(taxonomy, {
  elementById: new Map(taxonomy.elements.map(element => [element.id, element])),
  surfaceById: new Map(),
});

const compatibility = {
  taxonomy,
  taxonomy_digest: taxonomy.digest,
  element_ids: ["element-a", "element-b"],
  model: "model-a",
  artifact_contract_hashes: { "element-a": "artifact-a" },
  atif_ingestion_policy_hash: ATIF_INGESTION_POLICY_HASH,
};

const atif = parseScopeAtif({
  schema_version: "ATIF-v1.7",
  trajectory_id: "batch-test",
  session_id: "run-a",
  agent: { name: "fixture", version: "1.0.0" },
  steps: [{ step_id: 1, source: "user", message: "Test." }],
  extra: {
    scope: {
      schema_version: "scope.atif-extension.v1",
      trajectory_state: "complete",
      run: {
        request_id: "request-a",
        id: "run-a",
        scenario_id: "scenario-a",
        scenario_label: "Scenario A",
        profile_id: "profile-a",
        profile_label: "Profile A",
      },
      available_sources: [],
    },
  },
});

function success(
  root: string,
  fingerprint: string,
  input = atif,
): RunBatchSuccess {
  const results: Evaluation[] = compatibility.element_ids.map(elementId => ({
    schema_version: "scope/taxonomy-evaluation/v1" as const,
    taxonomy: {
      id: "taxonomy-a",
      version: "1.0.0",
      digest: compatibility.taxonomy_digest,
    },
    element: { id: elementId, label: elementId },
    implementation: {
      type: "prompt" as const,
      attempts: [{
        attempt: 1 as const,
        kind: "initial" as const,
        outcome: "succeeded" as const,
      }],
    },
    input: createInputIdentity(input, {
      archiveRoot: root,
      requestId: "request-a",
      runId: "run-a",
    }),
    status: "succeeded" as const,
    result: { state: "completed", observed: false },
  }));
  return {
    run: {
      id: "run-a",
      scenario: { id: "scenario-a", label: "Scenario A" },
      profile: { id: "profile-a", label: "Profile A" },
    },
    results,
    metadata: {
      taxonomy: {
        id: "taxonomy-a",
        version: "1.0.0",
        digest: compatibility.taxonomy_digest,
      },
      model: compatibility.model,
      artifact_contract_hashes: compatibility.artifact_contract_hashes,
      atif_ingestion_policy_hash:
        compatibility.atif_ingestion_policy_hash,
      element_ids: compatibility.element_ids,
      source: {
        archive_root: root,
        retained_evidence_sha256: fingerprint,
        request_id: "request-a",
        run_id: "run-a",
      },
      initialized: false,
    },
  };
}

const elements = [
  { id: "prompt", label: "Prompt Element", implementation: "prompt" as const },
  { id: "code", label: "Code Element", implementation: "deterministic" as const },
  { id: "other", label: "Other Code", implementation: "deterministic" as const },
];

function rows(count: number) {
  return Array.from({ length: count }, (_, sequence) => ({
    sequence,
    root: `request-${sequence}`,
    requestId: `request-${sequence}`,
    runId: `run-${sequence}`,
    initialStatus: "waiting" as const,
  }));
}

function stream(tty: boolean, columns = 100, terminalRows = 24) {
  const output = new PassThrough() as PassThrough & {
    isTTY?: boolean;
    columns?: number;
    rows?: number;
  };
  output.isTTY = tty;
  output.columns = columns;
  output.rows = terminalRows;
  let text = "";
  output.on("data", chunk => {
    text += chunk.toString();
  });
  return { output, text: () => text };
}

describe("multi-run batch support", () => {
  it("uses request/run identity and a stable root fallback filename", () => {
    expect(runBatchArchiveRoot({
      inputKind: "archive",
      root: "input",
    })).toBe("input");
    expect(runBatchArchiveRoot({
      inputKind: "plain",
      root: "input",
    })).toBeUndefined();
    expect(runBatchFilename({
      root: "root-a",
      fingerprint: "fingerprint",
      requestId: "request-a",
      runId: "run-a",
    })).toBe("request-a--run-a.json");
    expect(runBatchFilename({
      root: "unsafe root/a",
      fingerprint: "fingerprint",
    })).toMatch(/^a--[a-f0-9]{12}\.json$/);
    const first = runBatchFilename({
      root: "input",
      fingerprint: "same",
      origin: {
        selected_input: "/one/path/trajectory.json",
      },
    });
    const second = runBatchFilename({
      root: "input",
      fingerprint: "same",
      origin: {
        selected_input: "/two/path/trajectory.json",
      },
    });
    expect(first).toMatch(/^trajectory--[a-f0-9]{12}\.json$/);
    expect(second).toMatch(/^trajectory--[a-f0-9]{12}\.json$/);
    expect(first).not.toBe(second);
  });

  it("publishes one complete record and leaves no part file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taxonome-batch-"));
    const output = join(directory, "run.json");
    await writeRunBatchRecordAtomic(output, success("root-a", "fingerprint-a"));
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(
      success("root-a", "fingerprint-a"),
    );
    await expect((await import("node:fs/promises")).readdir(directory))
      .resolves.toEqual(["run.json"]);
  });

  it("resumes only exact compatible successful outputs without rewriting them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taxonome-resume-"));
    const provenance = createAtifProvenance(
      { file: "runs.tar.gz", archive_entry: "root-a/trajectory.json" },
      "$[0]",
      "ATIF-v1.7",
    );
    const source = {
      root: "root-a",
      fingerprint: "fingerprint-a",
      requestId: "request-a",
      runId: "run-a",
      atif,
      provenance,
    };
    const output = join(directory, runBatchFilename(source));
    const repaired = success(source.root, source.fingerprint);
    repaired.metadata.source.atif_provenance = provenance;
    repaired.results[0].implementation.attempts = [
      { attempt: 1, kind: "initial", outcome: "invalid_output" },
      { attempt: 2, kind: "repair", outcome: "succeeded" },
    ];
    await writeRunBatchRecordAtomic(output, repaired);
    const before = (await stat(output)).mtimeMs;

    const planned = await planRunBatch([source], directory, compatibility, false);
    expect(planned.jobs).toHaveLength(0);
    expect(planned.resumed).toHaveLength(1);
    expect((await stat(output)).mtimeMs).toBe(before);

    expect(await canResumeRunBatchJob(planned.resumed[0], {
      ...compatibility,
      model: "different-model",
    })).toBe(false);
    expect(await canResumeRunBatchJob({
      ...planned.resumed[0],
      provenance: {
        ...provenance,
        source_version: "ATIF-v1.8",
      },
    }, compatibility)).toBe(false);
    expect((await planRunBatch([source], directory, compatibility, true)).jobs).toHaveLength(1);
  });

  it("retries error, corrupt, stale fingerprint, and stale element outputs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taxonome-stale-"));
    const source = {
      root: "root-a",
      fingerprint: "fingerprint-a",
      requestId: "request-a",
      runId: "run-a",
      atif,
    };
    const output = join(directory, runBatchFilename(source));
    await writeFile(output, "{broken");
    expect((await planRunBatch([source], directory, compatibility, false)).jobs).toHaveLength(1);
    await writeRunBatchRecordAtomic(output, success(source.root, "stale"));
    expect((await planRunBatch([source], directory, compatibility, false)).jobs).toHaveLength(1);
    await writeRunBatchRecordAtomic(output, {
      ...success(source.root, source.fingerprint),
      metadata: {
        ...success(source.root, source.fingerprint).metadata,
        element_ids: ["element-a"],
      },
    });
    expect((await planRunBatch([source], directory, compatibility, false)).jobs).toHaveLength(1);
    await writeRunBatchRecordAtomic(output, {
      ...success(source.root, source.fingerprint),
      results: [],
    });
    expect((await planRunBatch([source], directory, compatibility, false)).jobs).toHaveLength(1);
    const failed = success(source.root, source.fingerprint);
    if (failed.results[0].status !== "succeeded") {
      throw new Error("Expected succeeded fixture evaluation");
    }
    const { result: _result, ...base } = failed.results[0];
    failed.results[0] = {
      ...base,
      status: "failed",
      error: {
        code: "invalid_output",
        message: "Invalid assessment.",
      },
    };
    await writeRunBatchRecordAtomic(output, failed);
    expect((await planRunBatch([source], directory, compatibility, false)).jobs)
      .toHaveLength(1);

    const malformedWrapper = success(source.root, source.fingerprint) as
      unknown as Record<string, unknown>;
    malformedWrapper.run = { id: "run-a" };
    await writeFile(output, JSON.stringify(malformedWrapper));
    expect((await planRunBatch([source], directory, compatibility, false)).jobs)
      .toHaveLength(1);

    for (const [field, value] of [
      ["trajectory_id", "tampered-document"],
      ["session_id", "tampered-session"],
      ["request_id", "tampered-request"],
      ["run_id", "tampered-run"],
      ["archive_root", "tampered-root"],
    ] as const) {
      const tampered = success(source.root, source.fingerprint);
      tampered.results[0].input = {
        ...tampered.results[0].input,
        [field]: value,
      };
      await writeRunBatchRecordAtomic(output, tampered);
      expect(
        (await planRunBatch([source], directory, compatibility, false)).jobs,
        field,
      ).toHaveLength(1);
    }

    const tamperedElement = success(source.root, source.fingerprint);
    tamperedElement.results[0].element.label = "Tampered";
    await writeRunBatchRecordAtomic(output, tamperedElement);
    expect((await planRunBatch([source], directory, compatibility, false)).jobs)
      .toHaveLength(1);
  });

  it("reaches but never exceeds the configured concurrency and preserves order", async () => {
    const jobs = Array.from({ length: 8 }, (_, sequence) => ({
      root: `root-${sequence}`,
      fingerprint: `fingerprint-${sequence}`,
      sequence,
      outputPath: `output-${sequence}`,
    })) satisfies RunBatchJob[];
    let active = 0;
    let maximum = 0;
    const releases: Array<() => void> = [];
    const outcomesPromise = runRootJobs(jobs, 3, async job => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise<void>(resolve => releases.push(resolve));
      active--;
      return job.sequence;
    });
    while (releases.length < 3) await new Promise(resolve => setTimeout(resolve, 0));
    while (releases.length) releases.shift()!();
    const interval = setInterval(() => releases.shift()?.(), 0);
    const outcomes = await outcomesPromise;
    clearInterval(interval);
    expect(maximum).toBe(3);
    expect(outcomes.map(outcome => outcome.value)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("continues after failures and marks unscheduled jobs cancelled", async () => {
    const jobs = Array.from({ length: 4 }, (_, sequence) => ({
      root: `root-${sequence}`,
      fingerprint: `${sequence}`,
      sequence,
      outputPath: `${sequence}.json`,
    })) satisfies RunBatchJob[];
    const controller = new AbortController();
    const continued = await runRootJobs(jobs, 2, async job => {
      if (job.sequence === 0) throw new Error("failure");
      return job.sequence;
    });
    expect(continued.map(outcome => outcome.status)).toEqual([
      "rejected",
      "fulfilled",
      "fulfilled",
      "fulfilled",
    ]);
    controller.abort();
    const cancelled = await runRootJobs(jobs, 2, async job => job.sequence, controller.signal);
    expect(cancelled.every(outcome => outcome.status === "cancelled")).toBe(true);
  });

  it("runs at most one element per run and continues after authored failures", async () => {
    let active = 0;
    let maximum = 0;
    const started: string[] = [];
    const completed: string[] = [];
    const sequence = await runElementsSequentially(
      elements,
      async element => {
        active++;
        maximum = Math.max(maximum, active);
        await Promise.resolve();
        active--;
        return {
          value: element.id,
          ...(element.id === "prompt"
            ? { failure: "authored prompt error" }
            : {}),
        };
      },
      {
        onStart: element => started.push(element.id),
        onComplete: (element, outcome) => {
          completed.push(`${element.id}:${outcome}`);
        },
      },
    );
    expect(maximum).toBe(1);
    expect(started).toEqual(["prompt", "code", "other"]);
    expect(completed).toEqual([
      "prompt:error",
      "code:done",
      "other:done",
    ]);
    expect(sequence).toEqual({
      values: ["prompt", "code", "other"],
      failures: ["authored prompt error"],
      cancelled: false,
    });
  });

  it("tracks resumed, parse-failed, active, and completed run states", () => {
    const target = stream(false);
    const plannedRows = rows(3);
    plannedRows[0].initialStatus = "resumed" as never;
    plannedRows[1].initialStatus = "failed" as never;
    const dashboard = new RunBatchDashboard({
      taxonomy: { id: "taxonomy-a", version: "1" },
      concurrency: 2,
      elements,
      rows: plannedRows,
      style: createTaxonomeStyle(target.output, {}),
      stream: target.output,
    });
    dashboard.start();
    expect(dashboard.snapshot()).toEqual([
      expect.objectContaining({ status: "resumed", done: 3, running: 0, waiting: 0 }),
      expect.objectContaining({ status: "failed", done: 0, running: 0, waiting: 0 }),
      expect.objectContaining({ status: "waiting", done: 0, running: 0, waiting: 3 }),
    ]);
    dashboard.startRun(2);
    dashboard.startElement(2, elements[0]);
    expect(dashboard.snapshot()[2]).toMatchObject({
      status: "running",
      done: 0,
      running: 1,
      waiting: 2,
      active: "Prompt Prompt Element",
    });
    dashboard.completeElement(2, elements[0], "error");
    dashboard.startElement(2, elements[1]);
    expect(dashboard.snapshot()[2]).toMatchObject({
      done: 1,
      running: 1,
      active: "Code Code Element",
    });
    dashboard.completeElement(2, elements[1], "done");
    dashboard.completeElement(2, elements[2], "done");
    dashboard.completeRun(2, "completed");
    expect(dashboard.finalize()).toEqual({
      evaluated: 1,
      resumed: 1,
      failed: 1,
      cancelled: 0,
      total: 3,
    });
    expect(target.text()).toContain("RUN RESUMED run-0");
    expect(target.text()).toContain("RUN FAILED run-1");
    expect(target.text()).toContain("ELEMENT ERROR run-2 :: Prompt");
    expect(target.text()).toContain("RUN COMPLETED run-2");
  });

  it("renders responsive run rows, spinner frames, semantic colors, and restores cursor", () => {
    vi.useFakeTimers();
    const target = stream(true, 100, 20);
    const plannedRows = rows(5);
    plannedRows[0].initialStatus = "resumed" as never;
    plannedRows[1].initialStatus = "failed" as never;
    const dashboard = new RunBatchDashboard({
      taxonomy: { id: "taxonomy-a", version: "1" },
      concurrency: 3,
      elements,
      rows: plannedRows,
      style: createTaxonomeStyle(target.output, {}),
      stream: target.output,
      throttleMs: 20,
      spinnerMs: 40,
    });
    dashboard.start();
    dashboard.startRun(2);
    dashboard.startElement(2, elements[0]);
    vi.advanceTimersByTime(20);
    const firstFrame = target.text();
    vi.advanceTimersByTime(80);
    expect(target.text()).not.toBe(firstFrame);
    dashboard.completeElement(2, elements[0], "done");
    dashboard.completeRun(2, "completed");
    dashboard.finalize();

    const output = target.text();
    expect(output).toContain("Taxonome run");
    expect(output).toMatch(/DONE\s+RUN\s+WAIT\s+ACTIVE/);
    expect(output).not.toContain("PASS");
    expect(output).toContain("\u001b[36m");
    expect(output).toContain("\u001b[34m");
    expect(output).toContain("\u001b[32m");
    expect(output).toContain("\u001b[31m");
    expect(output).toContain("\u001b[90m");
    expect((output.match(/\u001b\[\?25l/g) ?? [])).toHaveLength(1);
    expect((output.match(/\u001b\[\?25h/g) ?? [])).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    for (const line of output.split("\n").filter(Boolean)) {
      expect(dashboardVisibleWidth(line)).toBeLessThanOrEqual(100);
    }
  });

  it("keeps active and failed rows visible in narrow viewports with a hidden count", () => {
    const target = stream(true, 60, 9);
    const plannedRows = rows(10);
    plannedRows[1].initialStatus = "failed" as never;
    const dashboard = new RunBatchDashboard({
      taxonomy: { id: "a-very-long-taxonomy-name", version: "1" },
      concurrency: 4,
      elements,
      rows: plannedRows,
      style: createTaxonomeStyle(target.output, { NO_COLOR: "1" }),
      stream: target.output,
      throttleMs: 0,
    });
    dashboard.start();
    dashboard.startRun(7);
    dashboard.startElement(7, elements[0]);
    vi.useFakeTimers();
    vi.runOnlyPendingTimers();
    const snapshots = dashboard.snapshot();
    expect(snapshots.filter(snapshot => snapshot.running)).toHaveLength(1);
    dashboard.finalize();

    const output = target.text();
    expect(output).toContain("run-1");
    expect(output).toContain("run-7");
    expect(output).toMatch(/… \d+ hidden/);
    expect(output).not.toMatch(/\u001b\[(?:3[1-6]|9[0-7])m/);
    for (const line of output.split("\n").filter(Boolean)) {
      expect(dashboardVisibleWidth(line)).toBeLessThanOrEqual(60);
    }
  });

  it("keeps JSON and non-TTY lifecycle output append-only and control-free", () => {
    const target = stream(true);
    const dashboard = new RunBatchDashboard({
      taxonomy: { id: "taxonomy-a", version: "1" },
      concurrency: 1,
      elements,
      rows: rows(1),
      style: createTaxonomeStyle(target.output, { FORCE_COLOR: "1" }),
      stream: target.output,
      json: true,
    });
    dashboard.start();
    dashboard.startRun(0);
    dashboard.startElement(0, elements[0]);
    dashboard.completeElement(0, elements[0], "done");
    dashboard.completeRun(0, "completed");
    dashboard.finalize();
    expect(target.text()).toContain("BATCH 1 runs");
    expect(target.text()).toContain("ELEMENT START run-0");
    expect(target.text()).toContain("RUN COMPLETED run-0");
    expect(target.text()).not.toMatch(/\u001b\[/);
  });

  it("throttles scan rendering, supports unknown totals, and restores cursor", () => {
    vi.useFakeTimers();
    const target = stream(true, 72);
    const renderer = new ArchiveScanProgressRenderer(
      target.output,
      createTaxonomeStyle(target.output, {}),
      false,
      { throttleMs: 20, spinnerMs: 40 },
    );
    renderer.update({
      compressedBytes: 10,
      compressedTotalBytes: 100,
      entryCount: 1,
      rootCount: 1,
      streamedBytes: 50,
      retainedBytes: 20,
      complete: false,
    });
    const firstFrame = target.text();
    vi.advanceTimersByTime(80);
    expect(target.text()).not.toBe(firstFrame);
    renderer.finalize("complete");
    expect(target.text()).toContain("10%");
    expect(target.text()).toContain("1 roots");
    expect(target.text()).toContain("\u001b[?25l");
    expect(target.text()).toContain("\u001b[?25h");
    expect(vi.getTimerCount()).toBe(0);

    expect(formatScanProgress({
      compressedBytes: 2048,
      entryCount: 2,
      rootCount: 1,
      streamedBytes: 4096,
      retainedBytes: 1024,
      complete: false,
    })).not.toContain("%");

    const cancelledTarget = stream(true);
    const cancelled = new ArchiveScanProgressRenderer(
      cancelledTarget.output,
      createTaxonomeStyle(cancelledTarget.output, { NO_COLOR: "1" }),
    );
    cancelled.update({
      compressedBytes: 1,
      entryCount: 0,
      rootCount: 0,
      streamedBytes: 0,
      retainedBytes: 0,
      complete: false,
    });
    cancelled.finalize("cancelled");
    expect(cancelledTarget.text()).toContain("CANCELLED Scanning archive");
    expect((cancelledTarget.text().match(/\u001b\[\?25h/g) ?? [])).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("emits bounded plain scan milestones for non-TTY and JSON streams", () => {
    const target = stream(false);
    const renderer = new ArchiveScanProgressRenderer(
      target.output,
      createTaxonomeStyle(target.output, { FORCE_COLOR: "1" }),
      true,
    );
    for (let percent = 1; percent <= 100; percent++) {
      renderer.update({
        compressedBytes: percent,
        compressedTotalBytes: 100,
        entryCount: percent,
        rootCount: Math.ceil(percent / 25),
        streamedBytes: percent * 2,
        retainedBytes: percent,
        complete: percent === 100,
      });
    }
    renderer.finalize("complete");
    const lines = target.text().trim().split("\n");
    expect(lines[0]).toBe("SCAN START Scope archive");
    expect(lines.at(-1)).toContain("SCAN COMPLETE");
    expect(lines.length).toBeLessThanOrEqual(16);
    expect(target.text()).not.toMatch(/\u001b\[/);
  });
});
