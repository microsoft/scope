---
title: Choosing a coding agent
description: How to pick the right Scope coding agent — GitHub Copilot CLI, Claude Code CLI, or VS Code Copilot.
---

A **coding agent** is the AI-driven runtime that carries out a
task during a run. Scope supports three coding agents today.

| Coding agent | Worker ID | Drives | VS Code extensions | When to pick it |
| --- | --- | --- | --- | --- |
| **GitHub Copilot CLI** | `coder-acp-copilot` | GitHub Copilot via the Agent Client Protocol | ❌ | Benchmark Copilot in its lightest form. Fastest to spin up. |
| **Claude Code CLI** | `coder-acp-claude-code` | Anthropic Claude Code via ACP | ❌ | Benchmark Claude Code on the same task prompts. |

For the reference table with every column, see
[Coding agents & capabilities](/reference/workers/).

## Picking quickly

- **Comparing two agents** on the same task → use the matching
  ACP agent for each (`coder-acp-copilot` vs
  `coder-acp-claude-code`).
- **Measuring an extension's impact** → use VS Code Copilot.
  It's the only coding agent that can install extensions.
- **Default for most prompts** → GitHub Copilot CLI. Smallest
  moving parts.

## What's the same across all coding agents

- Same task prompts.
- Same criteria.
- Same MCP servers and skills.
- Same logs, status, and report tabs in the Portal.
- Same REST API.

This is by design: a benchmark you write once should run against
any supported coding agent.

## What differs

- **Available models.** Each coding agent exposes its own model
  list. GitHub Copilot CLI and Claude Code CLI advertise the
  models their respective agent supports. See
  [Model lifecycle and deprecation](/guides/model-lifecycle/) for how Scope
  discovers, retires, and restores models.
- **Extension support.** Only VS Code Copilot accepts
  `extensions` in a profile. The two CLI-based agents reject
  extensions with HTTP 400 — see
  [Defining profiles](/guides/defining-profiles/#worker-specific-constraints).
- **Startup time.** VS Code Copilot takes longer to start
  because it boots a full Electron VS Code.
- **Behavior under tools.** The same MCP server may behave
  differently under different agents — that's what you're
  measuring.

## Picking a coding agent in a request

### Portal

In the request submit form, set **Worker** before the model
dropdown populates. Or pick a
[profile](/guides/defining-profiles/) — its coding agent is
locked in.

### REST API

Set `workerType` (or pass a `profileId` / `profileVersionId`):

```json
{
  "scenario": {
    "task": "Create a Hello World Node.js / Express REST API.",
    "criteria": ["c-hello-world-express"]
  },
  "workerType": "coder-acp-copilot",
  "model": "gpt-4o"
}
```

## Tips

- **One profile per coding agent** when comparing. It's easier
  to run the same task against three profiles than to think
  about cross-cuts in your head.
- **Pin `agentVersion`** in profiles you'll use for repeated
  benchmarks — agent updates are common and otherwise become a
  hidden variable.

## See also

- [Coding agents & capabilities reference](/reference/workers/)
- [Defining profiles](/guides/defining-profiles/)
- [Using MCP servers, skills & extensions](/guides/mcp-skills-extensions/)
