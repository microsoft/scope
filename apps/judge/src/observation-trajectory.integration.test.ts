// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * ATIF-trajectory observation acceptance test (issue #1156, acceptance step 3).
 *
 * Proves the judge resolves a trajectory-only observation — one whose answer is
 * NOT derivable from the final workspace snapshot — by consuming the agent's
 * ATIF trajectory normalized into an {@link AgentTrajectory} and navigated via
 * the unified trajectory tools (list_agent_tool_calls / get_agent_tool_calls).
 * The canonical case is `dependency_added_then_removed`: a package is installed
 * then uninstalled mid-run, so it is invisible in the end-state snapshot and
 * only the trajectory reveals it.
 *
 * Two assertions form the acceptance:
 *   1. WITH the trajectory → criterion resolves passed:true (the judge actually
 *      consumed the ATIF via the navigation tools).
 *   2. WITHOUT the trajectory (snapshot only) → the same criterion flips to
 *      passed:false, proving the verdict comes from the trajectory, not the files.
 *
 * Exercises the REAL Copilot SDK, so it requires GITHUB_TOKEN (copilot scope) and
 * is skipped automatically when the token is absent — mirroring
 * judge-evaluation.integration.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resetCriteriaProvider } from "shared/criteria-provider-factory";
import { fromAtif, fromAtifList } from "./agent-trajectory.js";
import { evaluateWorkspace } from "./judge-agent.js";

const hasToken = !!process.env.GITHUB_TOKEN;
const JUDGE_MODEL = process.env.JUDGE_MODEL || "gpt-5.4-mini";

/**
 * Realistic ATIF trajectory (the exact shape pp-taxonomy downloads and forwards
 * via `fromAtif`): a system + user step, then agent steps that install
 * `left-pad`, use it, and uninstall it before finishing. Each agent step pairs
 * its `tool_calls[]` with the matching same-step `observation.results[]` by
 * `source_call_id === tool_call_id`. The final package.json (below) therefore
 * does NOT list left-pad — the add-then-remove is only in the trajectory.
 */
const REALISTIC_ATIF = {
  schema_version: "atif/1",
  session_id: "atif-trajectory-test",
  agent: {
    name: "copilot",
    version: "1.0.0",
    model_name: "claude-opus-4.6",
    tool_definitions: [
      {
        type: "function",
        function: {
          name: "bash",
          description: "Run a shell command in the workspace.",
          parameters: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "edit",
          description: "Edit a file in the workspace.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      },
    ],
  },
  steps: [
    { step_id: 1, source: "system" },
    { step_id: 2, source: "user" },
    {
      step_id: 3,
      source: "agent",
      model_name: "claude-opus-4.6",
      reasoning_content: "I'll add left-pad to pad the output.",
      tool_calls: [
        { tool_call_id: "call-1", function_name: "bash", arguments: { command: "npm install left-pad" } },
      ],
      observation: {
        results: [
          { source_call_id: "call-1", content: "added 1 package\n+ left-pad@1.3.0\nfound 0 vulnerabilities" },
        ],
      },
    },
    {
      step_id: 4,
      source: "agent",
      model_name: "claude-opus-4.6",
      tool_calls: [
        { tool_call_id: "call-2", function_name: "edit", arguments: { path: "index.js" } },
      ],
      observation: {
        results: [{ source_call_id: "call-2", content: "File index.js edited: now requires('left-pad')" }],
      },
    },
    {
      step_id: 5,
      source: "agent",
      model_name: "claude-opus-4.6",
      reasoning_content: "On reflection I don't need left-pad; removing it.",
      tool_calls: [
        { tool_call_id: "call-3", function_name: "bash", arguments: { command: "npm uninstall left-pad" } },
      ],
      observation: {
        results: [{ source_call_id: "call-3", content: "removed 1 package\nfound 0 vulnerabilities" }],
      },
    },
  ],
};

describe("judge ATIF-trajectory observation (integration)", () => {
  let workspaceDir: string;
  let criteriaDir: string;
  const saved: Record<string, string | undefined> = {};

  function setEnv(key: string, value: string): void {
    saved[key] = process.env[key];
    process.env[key] = value;
  }

  beforeAll(() => {
    workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), "judge-atif-ws-")));
    criteriaDir = realpathSync(mkdtempSync(join(tmpdir(), "judge-atif-crit-")));

    // End-state snapshot: package.json WITHOUT left-pad. The add-then-remove is
    // invisible here; only the trajectory reveals it.
    writeFileSync(
      join(workspaceDir, "package.json"),
      JSON.stringify({ name: "demo", version: "1.0.0", dependencies: {} }, null, 2) + "\n",
    );
    writeFileSync(join(workspaceDir, "index.js"), "console.log('hello');\n");

    // Observation criterion (matches config/criteria/dependency_added_then_removed.yaml).
    writeFileSync(
      join(criteriaDir, "dependency_added_then_removed.yaml"),
      [
        "id: dependency_added_then_removed",
        "kind: observation",
        "taxonomy_element_id: dimension:dependency-currency",
        "prompt: |",
        "  During the run the agent installed a package and later uninstalled or",
        "  removed it before finishing (e.g. added left-pad then removed it). This",
        "  is only derivable from the agent's trajectory (mid-run tool calls), not",
        "  from the final codebase snapshot, because the dependency is absent in the",
        "  end state. Use list_agent_tool_calls to scan the agent's tool calls and",
        "  get_agent_tool_calls to inspect the relevant ones, detecting a transient",
        "  add-then-remove of a dependency.",
        "",
      ].join("\n"),
    );

    setEnv("CRITERIA_DIR", criteriaDir);
    setEnv("JUDGE_STRATEGY", process.env.JUDGE_STRATEGY || "independent");
    setEnv("JUDGE_MODEL", JUDGE_MODEL);
    setEnv("FEEDBACK_MODEL", process.env.FEEDBACK_MODEL || JUDGE_MODEL);
    resetCriteriaProvider();
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetCriteriaProvider();
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(criteriaDir, { recursive: true, force: true });
  });

  it.skipIf(!hasToken)(
    "resolves a trajectory-only observation true WITH the ATIF, false WITHOUT it",
    { timeout: 600_000 },
    async () => {
      // (1) WITH the ATIF trajectory → the agent's add-then-remove is visible via
      // the navigation tools, so the observation must resolve true.
      const withAtif = await evaluateWorkspace({
        workspacePath: workspaceDir,
        criteria: ["dependency_added_then_removed"],
        conversationHistory: [],
        trajectory: fromAtif(REALISTIC_ATIF),
      });

      const obsWith = withAtif.criteriaResults.find(
        (r) => r.criterionId === "dependency_added_then_removed",
      );
      expect(obsWith, "observation result missing (with ATIF)").toBeTruthy();
      expect(obsWith!.evaluated).toBe(true);
      expect(
        obsWith!.passed,
        `expected trajectory-only observation to pass WITH ATIF. Feedback: ${obsWith!.feedback}`,
      ).toBe(true);

      // (2) WITHOUT the ATIF (snapshot only) → the add-then-remove is invisible
      // in the end state, so the same observation must flip to false. This proves
      // the verdict was driven by the trajectory, not the workspace files.
      const withoutAtif = await evaluateWorkspace({
        workspacePath: workspaceDir,
        criteria: ["dependency_added_then_removed"],
        conversationHistory: [],
      });

      const obsWithout = withoutAtif.criteriaResults.find(
        (r) => r.criterionId === "dependency_added_then_removed",
      );
      expect(obsWithout, "observation result missing (without ATIF)").toBeTruthy();
      expect(obsWithout!.evaluated).toBe(true);
      expect(
        obsWithout!.passed,
        `expected trajectory-only observation to FAIL without ATIF (snapshot has no left-pad). Feedback: ${obsWithout!.feedback}`,
      ).toBe(false);
    },
  );

  it("logs a skip note when GITHUB_TOKEN is absent (no real evaluation possible)", () => {
    if (!hasToken) {
      console.warn(
        "[integration] GITHUB_TOKEN not set — ATIF-trajectory observation test skipped",
      );
    }
    expect(true).toBe(true);
  });

  // The run-subject "killer" test (#1156): the add-then-remove is split ACROSS
  // iterations — iteration 1 installs left-pad, iteration 2 uninstalls it. Each
  // per-iteration ATIF alone is `false` (one only adds, the other only removes),
  // but the MERGED whole-run trajectory reveals the add-then-remove → `true`.
  // This is exactly the cross-iteration property the `subject:"run"` path exists
  // to evaluate, and the false-negative the user flagged.
  const ATIF_INSTALL = {
    schema_version: "atif/1",
    session_id: "atif-it1-install",
    agent: { name: "copilot", version: "1.0.0", model_name: "claude-opus-4.6", tool_definitions: [] },
    steps: [
      { step_id: 1, source: "system" },
      {
        step_id: 2,
        source: "agent",
        model_name: "claude-opus-4.6",
        reasoning_content: "Add left-pad to pad output.",
        tool_calls: [{ tool_call_id: "i1-c1", function_name: "bash", arguments: { command: "npm install left-pad" } }],
        observation: { results: [{ source_call_id: "i1-c1", content: "added 1 package\n+ left-pad@1.3.0" }] },
      },
    ],
  };

  const ATIF_UNINSTALL = {
    schema_version: "atif/1",
    session_id: "atif-it2-uninstall",
    agent: { name: "copilot", version: "1.0.0", model_name: "claude-opus-4.6", tool_definitions: [] },
    steps: [
      { step_id: 1, source: "system" },
      {
        step_id: 2,
        source: "agent",
        model_name: "claude-opus-4.6",
        reasoning_content: "Remove left-pad; not needed.",
        tool_calls: [{ tool_call_id: "i2-c1", function_name: "bash", arguments: { command: "npm uninstall left-pad" } }],
        observation: { results: [{ source_call_id: "i2-c1", content: "removed 1 package\nfound 0 vulnerabilities" }] },
      },
    ],
  };

  it.skipIf(!hasToken)(
    "run-subject: false per-iteration but true on the MERGED whole-run trajectory",
    { timeout: 600_000 },
    async () => {
      // (1) Iteration 1 alone (install only) → no add-then-remove → false.
      const it1 = await evaluateWorkspace({
        workspacePath: workspaceDir,
        criteria: ["dependency_added_then_removed"],
        conversationHistory: [],
        trajectory: fromAtif(ATIF_INSTALL),
      });
      const it1Obs = it1.criteriaResults.find((r) => r.criterionId === "dependency_added_then_removed");
      expect(it1Obs!.evaluated).toBe(true);
      expect(
        it1Obs!.passed,
        `iteration 1 (install only) should be false. Feedback: ${it1Obs!.feedback}`,
      ).toBe(false);

      // (2) Iteration 2 alone (uninstall only) → no add-then-remove → false.
      const it2 = await evaluateWorkspace({
        workspacePath: workspaceDir,
        criteria: ["dependency_added_then_removed"],
        conversationHistory: [],
        trajectory: fromAtif(ATIF_UNINSTALL),
      });
      const it2Obs = it2.criteriaResults.find((r) => r.criterionId === "dependency_added_then_removed");
      expect(it2Obs!.evaluated).toBe(true);
      expect(
        it2Obs!.passed,
        `iteration 2 (uninstall only) should be false. Feedback: ${it2Obs!.feedback}`,
      ).toBe(false);

      // (3) MERGED whole-run trajectory (install in it1 + uninstall in it2) →
      // the add-then-remove is now visible → true. This is what subject:"run"
      // sends the judge as `atifUrls` and is the false-negative the feature fixes.
      const merged = await evaluateWorkspace({
        workspacePath: workspaceDir,
        criteria: ["dependency_added_then_removed"],
        conversationHistory: [],
        trajectory: fromAtifList([ATIF_INSTALL, ATIF_UNINSTALL]),
      });
      const mergedObs = merged.criteriaResults.find((r) => r.criterionId === "dependency_added_then_removed");
      expect(mergedObs!.evaluated).toBe(true);
      expect(
        mergedObs!.passed,
        `merged whole-run trajectory should be true (add in it1, remove in it2). Feedback: ${mergedObs!.feedback}`,
      ).toBe(true);
    },
  );
});
