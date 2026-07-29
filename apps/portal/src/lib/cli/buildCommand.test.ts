// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import {
  shellQuote,
  buildRunSubmit,
  buildRunList,
  buildRunGet,
  buildRunAction,
  buildRunBulk,
} from "./buildCommand";

describe("shellQuote", () => {
  it("leaves safe bare words untouched", () => {
    expect(shellQuote("coder-acp-copilot")).toBe("coder-acp-copilot");
    expect(shellQuote("req_123")).toBe("req_123");
    expect(shellQuote("vercel-labs/agent-skills/my-skill")).toBe("vercel-labs/agent-skills/my-skill");
  });

  it("single-quotes values with spaces", () => {
    expect(shellQuote("hello world")).toBe("'hello world'");
  });

  it("escapes embedded single quotes", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("quotes empty strings explicitly", () => {
    expect(shellQuote("")).toBe("''");
  });
});

describe("buildRunSubmit", () => {
  it("omits defaults (worker, max-iterations) and empty fields", () => {
    const { command, notes } = buildRunSubmit({
      task: "build a snake game",
      worker: "coder-acp-copilot",
      maxIterations: 10,
    });
    expect(command).toBe("scope run submit -m 'build a snake game'");
    expect(notes).toEqual([]);
  });

  it("emits non-default worker, model, criteria and tool selections", () => {
    const { command } = buildRunSubmit({
      task: "task",
      worker: "coder-acp-claude-code",
      model: "claude-sonnet-4.5",
      reasoningEffort: "high",
      maxIterations: 20,
      criteria: ["has-tests", "compiles"],
      mcpServers: ["github"],
      skills: ["a/b/c"],
      extensions: ["ms-python.python"],
      agentVersion: "copilot-0.0.415",
      baseProfileId: "prof_1",
    });
    expect(command).toBe(
      "scope run submit -m task -c has-tests compiles -w coder-acp-claude-code " +
        "--model claude-sonnet-4.5 --reasoning-effort high --max-iterations 20 " +
        "--mcp-servers github --skills a/b/c --extensions ms-python.python " +
        "--agent-version copilot-0.0.415 --profile prof_1",
    );
  });

  it("surfaces Portal-only knobs as notes without dropping the command", () => {
    const { command, notes } = buildRunSubmit({
      task: "t",
      occurrences: 5,
      priority: 3,
      variationMode: true,
    });
    expect(command).toBe("scope run submit -m t");
    expect(notes).toHaveLength(3);
    expect(notes[0]).toContain("Occurrences (5)");
    expect(notes[1]).toContain("Priority (3)");
    expect(notes[2]).toContain("profile-variations-file");
  });

  it("includes the profile version in --profile when selected", () => {
    const { command } = buildRunSubmit({ task: "t", baseProfileId: "prof_1@3" });
    expect(command).toBe("scope run submit -m t --profile prof_1@3");
  });

  it("suppresses per-run worker/model/tool fields in variation mode", () => {
    const { command } = buildRunSubmit({
      task: "t",
      worker: "coder-acp-claude-code",
      model: "claude-sonnet-4.5",
      reasoningEffort: "high",
      mcpServers: ["github"],
      skills: ["a/b/c"],
      extensions: ["ms-python.python"],
      agentVersion: "copilot-0.0.415",
      baseProfileId: "prof_1@2",
      variationMode: true,
    });
    // Only task, base profile remain; the profiles supply the rest.
    expect(command).toBe("scope run submit -m t --profile prof_1@2");
  });
});

describe("buildRunList", () => {
  it("is a bare command with no filters", () => {
    expect(buildRunList({}).command).toBe("scope run list");
  });

  it("maps supported filters with operator symbols", () => {
    const { command } = buildRunList({
      worker: "coder-vscode-web",
      submissionId: "sub_9",
      turns: "5",
      turnsOp: "gte",
      maxIter: "10",
      maxIterOp: "lte",
      includeDeleted: true,
    });
    expect(command).toBe(
      "scope run list -w coder-vscode-web --submission-id sub_9 --turns '>=5' --max-iterations '<=10' --include-deleted",
    );
  });

  it("notes Portal-only filters that the CLI cannot express", () => {
    const { command, notes } = buildRunList({
      worker: "coder-acp-copilot",
      unsupportedFilters: ["status", "outcome", "task"],
    });
    expect(command).toBe("scope run list -w coder-acp-copilot");
    expect(notes[0]).toContain("status, outcome, task");
  });
});

describe("buildRunGet / buildRunAction", () => {
  it("builds get", () => {
    expect(buildRunGet("req_1").command).toBe("scope run get -i req_1");
  });

  it("builds retry with force", () => {
    expect(buildRunAction("retry", "req_1", { force: true }).command).toBe("scope run retry -i req_1 -f");
  });

  it("builds delete without force flag", () => {
    expect(buildRunAction("delete", "req_1", { force: true }).command).toBe("scope run delete -i req_1");
  });
});

describe("buildRunBulk", () => {
  it("uses a single variadic command for cancel", () => {
    expect(buildRunBulk("cancel", ["a", "b", "c"]).command).toBe("scope run cancel -i a b c");
  });

  it("collapses a single id to the plain action command", () => {
    expect(buildRunBulk("delete", ["a"]).command).toBe("scope run delete -i a");
  });

  it("emits a shell loop for multi-id delete (single-id CLI verb)", () => {
    expect(buildRunBulk("delete", ["a", "b"]).command).toBe(
      'for id in a b; do scope run delete -i "$id"; done',
    );
  });

  it("carries force into the retry loop", () => {
    expect(buildRunBulk("retry", ["a", "b"], { force: true }).command).toBe(
      'for id in a b; do scope run retry -i "$id" -f; done',
    );
  });
});
