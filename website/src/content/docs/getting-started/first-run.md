---
title: Your first run
description: Submit your first Scope request from the Portal in a few minutes.
---

This walkthrough takes you from a blank Portal to a completed
benchmark run. You'll submit a small "hello world" task to GitHub
Copilot, watch the logs stream in, and view the evaluation report.

In Scope, you submit a **request** (task prompt + criteria +
profile). Scope creates one **run** per execution attempt — see
[Concepts](/introduction/concepts/).

## Before you start

- You can reach the [Portal](/getting-started/access/) for your
  deployment, or have followed
  [Local development](/getting-started/local-development/).
- Your deployment has a running Copilot worker and access to an available
  model. If the catalog doesn't contain suitable task prompts, criteria, or
  profiles, create them as part of the steps below.

## 1. Open the Portal

Navigate to the Portal URL provided for your deployment, for example
**https://your-scope.example.com**.

Select or create a project to keep your evaluation data together.

The home view lists recent runs across all users. The left navigation
takes you to runs, tasks, criteria, profiles, prompt features, and
more.

## 2. Start a new request

Click **New Run** in the navigation. The form asks for three things:

1. **Task prompt** — type the text (or pick from recently used
   suggestions). Scope catalogs distinct prompts on the **Tasks**
   page for you, de-duplicated by text.
2. **Criteria** — pick a criteria set from the dropdown (or create one
   on the **Criteria** page first).
3. **Profile or inline configuration** — pick a Copilot profile, or
   set worker = GitHub Copilot CLI and a model inline.

For your first run, type or paste a simple task like *"Create a Hello
World Node.js / Express REST API."* and pick a matching criteria set
from the catalog (e.g. `hello-world-express`).

## 3. Pick a profile

Open the profile dropdown and pick a profile that uses the
**GitHub Copilot CLI** coding agent (any profile labeled with the
GitHub Copilot CLI agent will do).

If no Copilot profile exists yet, you can configure inline:

- **Worker**: GitHub Copilot CLI
- **Model**: any model offered in the dropdown (e.g. `gpt-4o`)
- Leave MCP servers, skills, and extensions empty

You can save your inline configuration as a profile later — see
[Defining profiles](/guides/defining-profiles/).

## 4. Submit

Click **Submit**. The Portal navigates to the request detail page.

## 5. Watch the logs

Logs stream in real time as the worker executes the run. You'll see:

- The agent receiving the prompt.
- Each tool call (read file, write file, run command).
- Any responses from the agent back to the prompt.

The status badge at the top tracks the request lifecycle:
**pending → queued → processing → done** (with `paused` as a separate
state you can toggle). The terminal **outcome** — `succeeded`,
`failed`, or `finished` — is shown alongside `done`.

## 6. Read the report

Once the run completes, open the **Report** tab — one entry per
criterion, with pass/fail and a short rationale from the judge.

For `hello-world-express`, you should see entries like:

- ✅ *Has a `package.json` with `express` as a dependency*
- ✅ *Has a main entry file that creates an Express server*
- ✅ *Has a `GET /` route that returns a hello-world response*

If a criterion fails, the rationale explains why — useful when
diagnosing prompt or criteria issues.

## What's next

Now that you've run a benchmark, you'll probably want to:

- [Submit requests from the CLI](/guides/submitting-requests-cli/)
  for a fast terminal-based workflow with log streaming.
- [Submit requests from the REST API](/guides/submitting-requests-api/)
  to automate this workflow.
- [Define a profile](/guides/defining-profiles/) so you can re-run the
  same agent setup consistently.
- [Manage task prompts](/guides/managing-task-prompts/) for benchmarks
  of your own.
- [Define evaluation criteria](/guides/defining-criteria/) tailored to
  your task prompts.
