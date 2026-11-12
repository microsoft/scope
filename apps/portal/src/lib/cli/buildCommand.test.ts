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
  buildEnvCommand,
  CLI_INSTALL_COMMAND,
  PROFILE_VARIATIONS_FILE,
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

describe("setup commands", () => {
  it("installs from the public microsoft/scope installer", () => {
    expect(CLI_INSTALL_COMMAND).toBe(
      "curl --fail --location https://raw.githubusercontent.com/microsoft/scope/main/install-cli.sh | bash",
    );
  });

  it("exports the API URL and, when selected, the project", () => {
    expect(buildEnvCommand("https://scope.example.com")).toBe("export SCOPE_API_URL=https://scope.example.com");
    expect(buildEnvCommand("http://localhost:5106", "proj_1")).toBe(
      "export SCOPE_API_URL=http://localhost:5106\nexport SCOPE_PROJECT=proj_1",
    );
  });
});

describe("buildRunSubmit", () => {
  it("always emits the worker and omits the API default max-iterations", () => {
    const { command, notes } = buildRunSubmit({
      task: "  build a snake game  ",
      worker: "coder-acp-copilot",
      maxIterations: 10,
    });
    expect(command).toBe("scope run submit -m 'build a snake game' -w coder-acp-copilot");
    expect(notes).toEqual([]);
  });

  it("emits model, criteria, tool selections and --count", () => {
    const { command } = buildRunSubmit({
      task: "task",
      worker: "coder-acp-claude-code",
      model: "claude-sonnet-4.5",
      reasoningEffort: "high",
      maxIterations: 20,
      occurrences: 5,
      criteria: ["has-tests", "compiles"],
      mcpServers: ["github"],
      skills: ["a/b/c"],
      extensions: ["ms-python.python"],
      agentVersion: "copilot-0.0.415",
      baseProfileId: "prof_1",
    });
    expect(command).toBe(
      "scope run submit -m task -c has-tests compiles -w coder-acp-claude-code " +
        "--model claude-sonnet-4.5 --reasoning-effort high --max-iterations 20 --count 5 " +
        "--mcp-servers github --skills a/b/c --extensions ms-python.python " +
        "--agent-version copilot-0.0.415 --profile prof_1",
    );
  });

  it("omits --count for a single occurrence", () => {
    expect(buildRunSubmit({ task: "t", worker: "w", occurrences: 1 }).command).toBe("scope run submit -m t -w w");
  });

  it("emits codebase, resources with params, AGENTS.md and gates", () => {
    const gates = [
      { gate: "select", promptId: "", criteria: ["c1"], maxIterations: 10 },
      { gate: "test", promptText: "run the tests", criteria: [], maxIterations: 3 },
    ];
    const { command, notes } = buildRunSubmit({
      task: "t",
      worker: "w",
      codebase: "my-repo@r2",
      resources: [{ ref: "postgres@r1", params: { DB_NAME: "app db" } }, { ref: "redis" }],
      agentsMd: "# Rules\nBe nice",
      gates,
    });
    expect(command).toBe(
      "scope run submit -m t -w w --codebase my-repo@r2 --resources postgres@r1 redis " +
        "--resource-param 'postgres@r1:DB_NAME=app db' --agents-md '# Rules\nBe nice' " +
        `--gates '${JSON.stringify(gates)}'`,
    );
    expect(notes).toEqual([]);
  });

  it("notes AGENTS.md content the CLI would read as a file path", () => {
    const { command, notes } = buildRunSubmit({ task: "t", worker: "w", agentsMd: "@team rules" });
    expect(command).toBe("scope run submit -m t -w w");
    expect(notes[0]).toContain("--agents-md @<path>");
  });

  it("surfaces Portal-only knobs as notes without dropping the command", () => {
    const { command, notes } = buildRunSubmit({ task: "t", worker: "w", occurrences: 12, priority: 3 });
    expect(command).toBe("scope run submit -m t -w w");
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain("Occurrences (12)");
    expect(notes[1]).toContain("Priority (3)");
  });

  it("includes the profile version in --profile when selected", () => {
    const { command } = buildRunSubmit({ task: "t", baseProfileId: "prof_1@3" });
    expect(command).toBe("scope run submit -m t --profile prof_1@3");
  });

  it("suppresses per-run worker/model/tool fields in variation mode", () => {
    const { command, notes } = buildRunSubmit({
      task: "t",
      worker: "coder-acp-claude-code",
      model: "claude-sonnet-4.5",
      reasoningEffort: "high",
      mcpServers: ["github"],
      skills: ["a/b/c"],
      extensions: ["ms-python.python"],
      agentVersion: "copilot-0.0.415",
      codebase: "repo",
      occurrences: 2,
      baseProfileId: "prof_1@2",
      profileVariations: ["prof_2@1", "prof_3"],
    });
    // Task, run-level fields and profiles remain; the profiles supply the rest.
    expect(command).toBe(
      `scope run submit -m t --count 2 --codebase repo --profile prof_1@2 --profile-variations-file ${PROFILE_VARIATIONS_FILE}`,
    );
    expect(notes).toEqual([
      `Save the profile variations to ${PROFILE_VARIATIONS_FILE} first: ` +
        `echo '["prof_2@1","prof_3"]' > ${PROFILE_VARIATIONS_FILE}`,
    ]);
  });

  it("ignores variations without a base profile", () => {
    const { command } = buildRunSubmit({ task: "t", worker: "w", profileVariations: ["prof_2"] });
    expect(command).toBe("scope run submit -m t -w w");
  });
});

describe("buildRunList", () => {
  it("is a bare command with no filters", () => {
    expect(buildRunList({}).command).toBe("scope run list");
  });

  it("maps every Portal filter, sort and comparator to its CLI flag", () => {
    const { command, notes } = buildRunList({
      workers: ["coder-vscode-web", "coder-acp-copilot"],
      statuses: ["done"],
      outcomes: ["failed", "__empty__"],
      task: "tp_1",
      profiles: ["prof_1"],
      criteria: "crit_1",
      models: ["gpt-5"],
      os: ["linux"],
      priorities: ["5"],
      agentVersions: ["copilot-0.0.415"],
      search: " snake game ",
      createdAfter: "2026-09-01T00:00:00.000Z",
      createdBefore: "2026-09-30T23:59:59.999Z",
      submissionId: "sub_9",
      turns: "5",
      turnsOp: "gte",
      maxIter: "10",
      maxIterOp: "lte",
      sortBy: "duration",
      sortDir: "asc",
      includeDeleted: true,
    });
    expect(command).toBe(
      "scope run list -w coder-vscode-web coder-acp-copilot --status done --outcome failed __empty__ " +
        "--task tp_1 --profile prof_1 --criteria crit_1 --model gpt-5 --os linux --priority 5 " +
        "--agent-version copilot-0.0.415 --search 'snake game' " +
        "--created-after 2026-09-01T00:00:00.000Z --created-before 2026-09-30T23:59:59.999Z " +
        "--submission-id sub_9 --turns '>=5' --max-iterations '<=10' --sort-by duration --sort-dir asc --include-deleted",
    );
    expect(notes).toEqual([]);
  });

  it("drops --sort-dir without --sort-by", () => {
    expect(buildRunList({ sortDir: "asc" }).command).toBe("scope run list");
  });

  it("notes Portal-only filters that the CLI cannot express", () => {
    const { command, notes } = buildRunList({
      workers: ["coder-acp-copilot"],
      unsupportedFilters: ["foo", "bar"],
    });
    expect(command).toBe("scope run list -w coder-acp-copilot");
    expect(notes[0]).toContain("foo, bar");
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

  it("uses download-batch for a multi-id download", () => {
    expect(buildRunBulk("download", ["a", "b"]).command).toBe("scope run download-batch -i a b");
  });

  it("uses plain download for a single id", () => {
    expect(buildRunBulk("download", ["a"]).command).toBe("scope run download -i a");
  });

  it("carries force into the retry loop", () => {
    expect(buildRunBulk("retry", ["a", "b"], { force: true }).command).toBe(
      'for id in a b; do scope run retry -i "$id" -f; done',
    );
  });
});
