---
title: What is Scope?
description: An overview of Scope — the platform for measuring the agentic coding experience across agents, at scale.
---

**Scope** is a self-service platform for **measuring the agentic
coding experience of your product surfaces, skills, MCP servers,
and extensions** — across agents, at scale. It runs the same coding
task across different agents, tools, and models, evaluates the
outcomes against criteria you define, and lets you compare results
side by side.

The goal isn't just "did the code work?" — it's understanding how
the agent *behaved* on the way there: what it asked for, what tools
it reached for, where it got stuck, and how that changes when you
swap the agent, the model, or the surrounding tools.

## What you can do with Scope

- **Submit a coding task** and have it executed by your choice of agent —
  GitHub Copilot, Claude Code, or VS Code with the Copilot driver
  extension.
- **Save reusable agent setups as profiles** — a profile bundles the
  worker, model, agent version, MCP servers, skills, and extensions so
  you can re-run the same configuration consistently.
- **Define what "good" looks like** with evaluation criteria. Criteria
  live in a directed acyclic graph (DAG) so children can be gated on
  their parents passing — use it for multi-step evaluation, or just
  leave dependencies off and every criterion becomes a root.
- **Watch runs in real time** as logs stream from the worker.
- **Inspect the evidence.** Review generated files, workspace snapshots,
  criteria results, captured agent activity, reports, and insights.
- **Evaluate changes.** Reuse tasks, profiles, and versioned starting codebases
  to compare surfaces such as CLIs, MCP servers, skills, and documentation,
  as well as models, context, tasks, and operating systems.
- **Compare across heterogeneous tasks** using prompt features —
  characteristics Scope detects on your task prompt (e.g. "asks for
  an API", "asks for TypeScript") so you can ask questions like *"how
  does Claude Code do on database tasks vs. Copilot?"* without manually
  tagging every run.
- **Automate everything** through the REST API or the `scope` CLI —
  submit runs, manage profiles and criteria, fetch results.

## How it works

1. **Define** a task, its evaluation criteria, and the agent configuration.
2. **Submit** a request through the Portal or CLI. The API stores the request
   in MongoDB. The scheduler claims pending runs and dispatches them to the
   appropriate storage queue.
3. **Execute and evaluate.** The worker runs the agent and asks the Judge to
   evaluate its output. Runs can include multiple feedback iterations.
4. **Inspect and compare.** Review logs, snapshots, and criteria results.
   Post-processing and report workers produce additional analysis when enabled.

| Service | Role in a run |
| --- | --- |
| MongoDB | Stores evaluation configuration, run records, worker status updates, and the Judge's criteria results. |
| Storage Queues | Deliver work from the scheduler to coding-agent workers. |
| Redis | Relays worker logs and live events to the API for Portal and CLI clients. |
| Blob Storage | Holds larger artifacts, including workspace snapshots written by workers. |

Local development uses MongoDB, Redis, Azurite (the Azure Storage emulator),
and Lowkey Vault. See
[Local development](/getting-started/local-development/) to run the stack, or
the
[system architecture](https://github.com/microsoft/scope/blob/main/docs/architecture/system-architecture.md)
for service details and production deployment considerations.

## When Scope is the right tool

Use Scope when you want to:

- Compare the agentic behavior of two or more coding agents on the
  same task.
- Track how a single agent's behavior changes across versions or model
  swaps.
- Evaluate the impact of MCP servers, skills, or extensions on coding
  outcomes.
- Build a shared, reproducible measurement suite that your team can
  extend over time.

It is **not** a hosted IDE or an agent runtime you embed in your own
products — it's a measurement platform that drives existing agents
against tasks you control.

## Who it's for

Scope is for teams that need to measure and compare AI coding
agents:

- **Product managers** evaluating how coding agents use their software and
  respond to feedback.
- **Engineers** designing task prompts and criteria to characterize the
  agentic experience.
- **Researchers** comparing agent trajectories across diverse tasks.
- **Pipelines and tooling** that submit runs programmatically via the
  REST API.

## Interpreting results

A working result is only part of the agentic experience. Use repeatable
evaluations to understand both successes and failures, including the steps an
agent took and how it responded to feedback.

Results describe the tasks and configurations you tested, not a universal
agent ranking. The automated Judge can make mistakes; important conclusions
need human review. See [Support and security](/resources/support/) for
responsible-use guidance.

## Where to next

- New here? Read [Concepts](/introduction/concepts/) to get familiar with
  the vocabulary.
- Ready to submit your first run? Jump to
  [Access](/getting-started/access/).
- Want to run Scope locally? Follow
  [Local development](/getting-started/local-development/).
- Interested in improving Scope? Read [Contributing](/resources/contributing/).
