---
title: Concepts
description: The core vocabulary used throughout Scope.
---

This page introduces the concepts you'll encounter throughout Scope.
Each one is described in more depth in its own guide; this page is your
map.

## Request

A **request** is what you submit to Scope. It bundles:

- A **task prompt** (as text) — what to ask the agent. Scope
  de-duplicates by text so the same prompt across requests links to
  the same task prompt record.
- A **criteria set** (by ID) — how the result is judged.
- A **profile** (by ID or version ID) or an inline runtime
  configuration — which agent, model, and tools to use.
- A **priority** and a few options like `maxIterations`.

You don't run anything yourself — submitting a request hands the work
to Scope.

See [Submitting requests (Portal)](/guides/submitting-requests-portal/).

## Run

A **run** is a single execution attempt of a request by a worker. The
first time Scope picks up a request, it creates a run; if you
**retry**, a new run is appended. A request therefore has one or more
runs over its lifetime.

Logs and the per-criterion report are produced per run.

## Task prompt

The text instructions sent to the agent. Task prompts are kept in a
shared catalog: when you submit a request, Scope de-duplicates by
text so the same wording across different requests links to the same
task prompt record. Prompt-feature detection runs against task prompts.

See [Managing task prompts](/guides/managing-task-prompts/).

## Criteria

**Evaluation criteria** describe what makes a run successful. Each
criterion is a single statement the judge evaluates against the run's
output. Criteria are reusable records referenced by ID from a request.

Criteria always form a **directed acyclic graph (DAG)**: declaring
`dependsOn` makes a criterion gate on its parents passing. A
criterion with no `dependsOn` is just a root — always evaluated. A
graph with no edges is a perfectly valid DAG; there's no separate
"flat" mode.

See [Defining evaluation criteria](/guides/defining-criteria/).

## Profile

A **profile** captures the full agent setup needed to execute a
request: worker type, model, agent version, MCP servers, skills, and
(where applicable) VS Code extensions.

Profiles are versioned. Identity (name, description) is mutable; every
saved version is **immutable** — once created, version 2 is frozen
forever. This is what makes runs reproducible.

See [Defining profiles](/guides/defining-profiles/).

## Judge

The **judge** is the service that evaluates a completed run against its
criteria and produces the report.

## Report

The **report** is the structured pass/fail outcome of a run, with
per-criterion rationale. Reports are produced per run.

## Worker

A **worker** is the runtime that drives the AI coding agent. Scope
ships three workers today:

- **GitHub Copilot CLI** — drives GitHub Copilot through the
  Agent Client Protocol.
- **Claude Code CLI** — drives Anthropic's Claude Code through
  ACP.
- **VS Code Copilot** — drives an Electron-based VS Code
  instance with a driver extension. The only coding agent that
  supports VS Code extensions.

See [Choosing a coding agent](/guides/choosing-a-coding-agent/).

## Prompt feature

A **prompt feature** is a tag Scope detects on a task prompt (e.g.
`asks_for_api`, `asks_for_typescript`, `asks_for_database`). Features
are decoupled from the request — they describe the *prompt* itself —
so you can group runs by feature and compare agents across
heterogeneous tasks.

See [Working with prompt features](/guides/prompt-features/).

## MCP servers, skills & extensions

Optional capabilities that extend what an agent can do during a run:

- **MCP servers** — Model Context Protocol servers that expose tools
  the agent can call.
- **Skills** — packaged Copilot agent skills, pinned to specific
  commits for reproducibility.
- **Extensions** — VS Code extensions installed for the duration of a
  run (VS Code Copilot only).

All three are properties of a profile.
See [Using MCP servers, skills & extensions](/guides/mcp-skills-extensions/).

## Evaluation building blocks

| Concept | Purpose |
| --- | --- |
| Tasks and scenarios | Define the work the agent should perform. |
| Criteria | Define observable checks and dependencies in the Judge's criteria DAG. |
| Personas | Configure the evaluation perspective and feedback style. |
| Profiles and variations | Save an agent configuration and compare changes against a baseline. |
| Skills and MCP servers | Provide agent instructions and tools through the Model Context Protocol. |
| Codebases | Seed a run with a versioned starting workspace. |

The YAML files in
[config/](https://github.com/microsoft/scope/tree/main/config) are portable
examples, not the live configuration database. MongoDB is the runtime source
of truth. Manage configuration through the Portal or CLI; don't assume that
editing an example file changes an existing evaluation.
