---
title: FAQ
description: Frequently asked questions about Scope.
---

## What is Scope, in one sentence?

A platform for measuring the agentic coding experience of your product
across AI coding agents — by submitting **requests** that pair a task
prompt, criteria, and a profile, and inspecting the structured pass/
fail reports of the resulting **runs**.

## Who is it for?

Teams who want to measure and compare AI coding agents across models,
tools, and configurations on repeatable tasks.

## How do I get access?

Open the Portal URL provided for your deployment and follow its access
requirements. See [Access](/getting-started/access/).

## Which agents can it drive today?

Three workers ship today:

- **GitHub Copilot CLI** — `coder-acp-copilot`
- **Claude Code CLI** — `coder-acp-claude-code`

See [Coding agents & capabilities](/reference/workers/).

## What's the difference between a request and a run?

A **request** is what you submit (task prompt + criteria + profile).
A **run** is one execution attempt of that request by a worker. The
first attempt is created automatically; each retry adds another run on
the same request. Logs and reports are per run.

## Why are profile versions immutable?

So that "run profile X v3 again next month" gives you the *same*
agent runtime — same agent version, same skills (pinned to commits),
same extensions (pinned to versions), same MCP servers. Without that
guarantee, year-over-year comparisons aren't trustworthy.

If you need to change *anything* about a profile version, create a
new version. The identity (name, description) is mutable separately.

## Can I run the same task prompt against multiple profiles?

Yes — that's the main use case. Submit a request per profile against
the same task prompt and criteria set.

## When are prompt features extracted?

On demand, not automatically. From the Portal, click **Extract
features** on a task prompt. From the API, `POST
/api/v1/task-prompts/{id}/extract-features`. See
[Working with prompt features](/guides/prompt-features/).

## Can I install VS Code extensions in any request?

ACP workers reject `extensions` with HTTP 400. See
[Choosing a coding agent](/guides/choosing-a-coding-agent/).

## How do I bump a stuck request?

Change its priority (range −10 to +10), or pause lower-priority
requests. See
[Prioritizing & pausing requests](/guides/prioritizing-requests/).

## Does Scope provide a CLI?

Yes. The `scope` CLI lets you submit runs, stream logs, manage
profiles, and more — all from the terminal. See
[Install the CLI](/getting-started/install-cli/) to get started.

## Where's the API reference?

The auto-generated [REST API reference](/reference/api/) is
built from the committed OpenAPI snapshot. A narrative overview of the
resource groups is at the [REST API overview](/reference/rest-api/).
