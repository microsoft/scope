---
title: Glossary
description: Definitions of the core Scope concepts.
---

## Request

What you submit to Scope. A request bundles a task prompt, a
criteria graph, and a profile (or inline runtime configuration).
Scope creates one or more runs per request. See
[Submitting requests (Portal)](/guides/submitting-requests-portal/).

## Run

A single execution attempt of a request by a worker. The first attempt
is created when Scope picks the request up; each retry creates a
new run on the same request. Logs and reports are produced per run.

## Task prompt

The text instructions sent to the agent. Stored in a shared catalog,
de-duplicated by text: when you submit a request with task text
Scope has seen before, the request links to the existing record
rather than creating a duplicate. Prompt-feature detection runs
against this text. See [Managing task prompts](/guides/managing-task-prompts/).

## Criteria / Criterion

A criterion is a single, observable statement the judge evaluates the
run's output against. Criteria form a **directed acyclic graph (DAG)**.
Each criterion can depend on other criteria; a criterion without
dependencies is a root of the graph. See
[Defining evaluation criteria](/guides/defining-criteria/).

## Judge

The component that evaluates a run's output against the request's
criteria and produces the report. Powered by an LLM.

## Report

The structured pass/fail outcome of a run, with rationale per
criterion. Produced by the judge, generated on demand.

## Profile

A reusable, versioned description of an agent runtime configuration
(worker, model, agent version, MCP servers, skills, extensions). A
profile has a stable identity and a series of immutable versions. See
[Defining profiles](/guides/defining-profiles/).

## Profile version

An immutable snapshot of a profile's runtime configuration.
Re-running the same profile version always exercises the same agent
code, skill commits, and extension versions.

## Worker

The runtime that drives an AI coding agent during a run. See
[Coding agents & capabilities](/reference/workers/).

## ACP (Agent Client Protocol)

The protocol the Copilot and Claude Code workers use to talk to their
respective agents. Implementation detail for users; mentioned here
because it shows up in worker IDs (`coder-acp-*`).

## MCP server

A Model Context Protocol server. Exposes tools the agent can call
during a run. Referenced from a profile by slug.

## Skill / Skill revision

A packaged Copilot agent skill, identified by a Git path. When
referenced from a profile, Scope pins the skill to a specific
commit hash so re-runs are reproducible.

## Extension

A VS Code extension installed for the duration of a run. See
[Coding agents & capabilities](/reference/workers/) for compatibility.

## Prompt feature

A boolean characteristic auto-detected on a task prompt (e.g.
`asks_for_api`). Used to slice and group runs across heterogeneous
tasks. See [Working with prompt features](/guides/prompt-features/).

## Detection prompt

The prompt the LLM uses to decide whether a given prompt feature
applies to a task prompt. Stored on the feature catalog entry.
