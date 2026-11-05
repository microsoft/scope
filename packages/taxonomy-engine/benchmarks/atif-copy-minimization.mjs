// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { glob, readFile, writeFile } from "node:fs/promises";
import { Session } from "node:inspector";
import { performance } from "node:perf_hooks";
import process from "node:process";

const root = process.cwd();
const script = new URL(import.meta.url).pathname;

function opaque(seed, bytes) {
  return {
    seed,
    blob: `${seed}:`.repeat(Math.ceil(bytes / (seed.length + 1)))
      .slice(0, bytes),
    nested: {
      flags: Array.from({ length: 32 }, (_, index) => index % 3 === 0),
      labels: Array.from({ length: 24 }, (_, index) => `${seed}-${index}`),
    },
  };
}

function v16Input() {
  return [{
    schema_version: "ATIF-v1.6",
    session_id: "benchmark-v16",
    agent: {
      name: "benchmark",
      version: "1.0.0",
      extra: { vendor: opaque("agent-v16", 32_768) },
    },
    steps: Array.from({ length: 24 }, (_, index) => ({
      step_id: index + 1,
      source: "user",
      message: `step ${index}`,
      extra: { vendor: opaque(`step-v16-${index}`, 8_192) },
    })),
    extra: { vendor: opaque("root-v16", 262_144) },
  }];
}

function v17Input() {
  return [{
    schema_version: "ATIF-v1.7",
    trajectory_id: "benchmark-v17",
    session_id: "benchmark-run",
    agent: {
      name: "benchmark",
      version: "1.0.0",
      extra: { vendor: opaque("agent-v17", 32_768) },
    },
    steps: Array.from({ length: 24 }, (_, index) => ({
      step_id: index + 1,
      source: "agent",
      message: `call ${index}`,
      tool_calls: [{
        tool_call_id: `call-${index}`,
        function_name: "benchmark/query",
        arguments: { payload: opaque(`args-${index}`, 8_192) },
        extra: {
          vendor: opaque(`call-extra-${index}`, 4_096),
          scope: {
            outcome: "completed",
            response: {
              result: opaque(`response-${index}`, 4_096),
            },
          },
        },
      }],
      extra: { vendor: opaque(`step-v17-${index}`, 4_096) },
    })),
    extra: {
      vendor: opaque("root-v17", 131_072),
      scope: {
        schema_version: "scope.atif-extension.v1",
        trajectory_state: "complete",
        available_sources: [],
      },
    },
  }];
}

function v18Input() {
  const child = {
    schema_version: "ATIF-v1.7",
    trajectory_id: "benchmark-child",
    session_id: "shared-run",
    agent: {
      name: "benchmark-child",
      version: "1.0.0",
      extra: { vendor: opaque("child-agent", 16_384) },
    },
    steps: Array.from({ length: 12 }, (_, index) => ({
      step_id: index + 1,
      source: "user",
      message: `child ${index}`,
      extra: { vendor: opaque(`child-step-${index}`, 8_192) },
    })),
    extra: { vendor: opaque("child-root", 65_536) },
  };
  return {
    schema_version: "ATIF-v1.8",
    trajectory_id: "benchmark-v18",
    session_id: "shared-run",
    agent: {
      name: "benchmark",
      version: "1.0.0",
      extra: { vendor: opaque("agent-v18", 32_768) },
    },
    steps: [{
      step_id: 1,
      source: "user",
      message: [
        { type: "text", text: "Inspect media." },
        {
          type: "audio",
          source: {
            media_type: "audio/mp3",
            path: "audio/example.mp3",
            duration_sec: null,
          },
        },
      ],
      extra: { vendor: opaque("step-v18", 131_072) },
    }],
    subagent_trajectories: [child],
    extra: { vendor: opaque("root-v18", 262_144) },
  };
}

async function realInputs() {
  const files = [];
  for await (const file of glob("docs/ax-playbook/assets/**/trajectory.json")) {
    files.push(file);
  }
  files.sort();
  const selected = [
    ...files.slice(0, 3),
    ...files.slice(37, 40),
    ...files.slice(40, 43),
    ...files.slice(-3),
  ];
  return Promise.all(selected.map(async file => ({
    file,
    value: JSON.parse(await readFile(file, "utf8")),
  })));
}

function collectObjects(value, output = new Set()) {
  if (!value || typeof value !== "object" || output.has(value)) return output;
  output.add(value);
  for (const child of Object.values(value)) collectObjects(child, output);
  return output;
}

function countSharedObjects(left, right) {
  const leftObjects = collectObjects(left);
  let shared = 0;
  for (const object of collectObjects(right)) {
    if (leftObjects.has(object)) shared++;
  }
  return {
    input_objects: leftObjects.size,
    output_objects: collectObjects(right).size,
    shared_objects: shared,
  };
}

function post(session, method, params = {}) {
  return new Promise((resolve, reject) => {
    session.post(method, params, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

function sampledBytes(node) {
  return node.selfSize +
    node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
}

async function workload(name) {
  if (name === "synthetic-v16-opaque") {
    return { sources: [{ value: v16Input() }], iterations: 12 };
  }
  if (name === "synthetic-v17-scope-response") {
    return { sources: [{ value: v17Input() }], iterations: 8 };
  }
  if (name === "synthetic-v18-embedded") {
    return { sources: [{ value: v18Input() }], iterations: 12 };
  }
  if (name === "real-playbook-12") {
    return { sources: await realInputs(), iterations: 1 };
  }
  throw new Error(`Unknown workload '${name}'`);
}

async function runWorker(name) {
  if (typeof global.gc !== "function") {
    throw new Error("Run with --expose-gc");
  }
  const { ingestAtif } = await import(
    `${root}/packages/taxonomy-engine/src/atif/ingest.ts`
  );
  const { canonicalJsonSha256 } = await import(
    `${root}/packages/taxonomy-engine/src/canonical-json.ts`
  );
  const definition = await workload(name);
  global.gc();
  const before = process.memoryUsage();
  const maxRssBefore = process.resourceUsage().maxRSS;
  const session = new Session();
  session.connect();
  await post(session, "HeapProfiler.startSampling", {
    samplingInterval: 32_768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });

  const outputs = [];
  let peakHeap = before.heapUsed;
  let peakRss = before.rss;
  const started = performance.now();
  for (let iteration = 0; iteration < definition.iterations; iteration++) {
    for (const source of definition.sources) {
      outputs.push(ingestAtif(source.value, {
        file: source.file ?? `${name}.json`,
      }));
      const memory = process.memoryUsage();
      peakHeap = Math.max(peakHeap, memory.heapUsed);
      peakRss = Math.max(peakRss, memory.rss);
    }
  }
  const elapsedMs = performance.now() - started;
  const profile = await post(session, "HeapProfiler.stopSampling");
  session.disconnect();

  global.gc();
  const retained = process.memoryUsage();
  const maxRssAfter = process.resourceUsage().maxRSS;
  const combinedHash = createHash("sha256");
  for (const output of outputs) {
    combinedHash.update(canonicalJsonSha256(output.atif));
    combinedHash.update("\0");
  }
  const firstSource = definition.sources[0].value;
  const firstOutput = outputs[0];
  const references = countSharedObjects(firstSource, firstOutput.atif);
  const documents = outputs.length;
  const mappingCount = outputs.reduce(
    (sum, output) => sum + output.provenance.mappings.length,
    0,
  );
  console.log(JSON.stringify({
    workload: name,
    documents,
    elapsed_ms: elapsedMs,
    sampled_allocation_bytes: sampledBytes(profile.profile.head),
    sampled_allocation_bytes_per_document:
      sampledBytes(profile.profile.head) / documents,
    observed_peak_heap_delta_bytes: peakHeap - before.heapUsed,
    observed_peak_rss_delta_bytes: peakRss - before.rss,
    max_rss_growth_kib: maxRssAfter - maxRssBefore,
    retained_heap_delta_bytes: retained.heapUsed - before.heapUsed,
    retained_rss_delta_bytes: retained.rss - before.rss,
    mappings_per_document: mappingCount / documents,
    combined_hash: combinedHash.digest("hex"),
    references,
  }));
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}

async function runParent(output) {
  const workloads = [
    "synthetic-v16-opaque",
    "synthetic-v17-scope-response",
    "synthetic-v18-embedded",
    "real-playbook-12",
  ];
  const repeats = 5;
  const samples = {};
  for (const name of workloads) {
    samples[name] = [];
    for (let repeat = 0; repeat < repeats; repeat++) {
      const child = spawnSync(process.execPath, [
        "--expose-gc",
        "--import",
        "tsx",
        script,
        "--worker",
        name,
      ], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_NO_WARNINGS: "1",
        },
      });
      if (child.status !== 0) {
        throw new Error(
          `Benchmark worker '${name}' failed:\n${child.stderr || child.stdout}`,
        );
      }
      samples[name].push(JSON.parse(child.stdout));
    }
  }
  const metrics = {};
  for (const [name, rows] of Object.entries(samples)) {
    const first = rows[0];
    metrics[name] = {
      documents: first.documents,
      combined_hash: first.combined_hash,
      mappings_per_document: first.mappings_per_document,
      references: first.references,
      median_elapsed_ms: median(rows.map(row => row.elapsed_ms)),
      median_sampled_allocation_bytes: median(
        rows.map(row => row.sampled_allocation_bytes),
      ),
      median_sampled_allocation_bytes_per_document: median(
        rows.map(row => row.sampled_allocation_bytes_per_document),
      ),
      median_observed_peak_heap_delta_bytes: median(
        rows.map(row => row.observed_peak_heap_delta_bytes),
      ),
      median_observed_peak_rss_delta_bytes: median(
        rows.map(row => row.observed_peak_rss_delta_bytes),
      ),
      median_max_rss_growth_kib: median(
        rows.map(row => row.max_rss_growth_kib),
      ),
      median_retained_heap_delta_bytes: median(
        rows.map(row => row.retained_heap_delta_bytes),
      ),
      median_retained_rss_delta_bytes: median(
        rows.map(row => row.retained_rss_delta_bytes),
      ),
      samples: rows,
    };
  }
  const result = {
    format: "taxonome-atif-copy-benchmark/v1",
    head: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    repeats,
    command:
      `node --expose-gc --import tsx ${script} --output ${output}`,
    metrics,
  };
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}

const workerIndex = process.argv.indexOf("--worker");
if (workerIndex >= 0) {
  await runWorker(process.argv[workerIndex + 1]);
} else {
  const outputIndex = process.argv.indexOf("--output");
  if (outputIndex < 0 || !process.argv[outputIndex + 1]) {
    throw new Error("--output is required in parent mode");
  }
  await runParent(process.argv[outputIndex + 1]);
}
