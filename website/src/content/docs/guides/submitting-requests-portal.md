---
title: Submitting requests (Portal)
description: How to submit, monitor, and inspect Scope requests from the Portal.
---

The Portal is the primary way to interact with Scope when you're
exploring, debugging, or designing benchmarks. This guide covers the
full submit-and-inspect workflow.

For automation, see
[Submitting requests (REST API)](/guides/submitting-requests-api/).
For terminal workflows, see
[Submitting requests (CLI)](/guides/submitting-requests-cli/).

## What you submit

You submit a **request**. A request bundles:

1. A **task prompt** — what to ask the agent.
2. A **criteria set** — how to judge the result.
3. A **profile** (or inline runtime configuration) — which agent,
   model, and tools to use.
4. An optional **codebase** — the versioned project snapshot to seed
   into the agent's workspace.

When Scope picks up your request, it creates a **run** (one
execution attempt). A retry creates a new run on the same request.

## Open the submit form

From the Portal navigation, click **New Run** (the form name in the
Portal — it submits a request). The form is split into the three
sections above.

## 1. Write the task prompt

Type the prompt text into the **Task** field. You can also pick from
recently used prompts in the suggestions list — those are entries from
the shared **Tasks** catalog.

You don't reference a task prompt by ID; you write the text. Behind
the scenes Scope looks up (or creates) the matching task prompt
record in the catalog so the same text across requests links to the
same record. See [Managing task prompts](/guides/managing-task-prompts/).

## 2. Pick the criteria

Pick a criteria set from the picker. Criteria sets are reusable and
referenced by ID — you can use the same set across many task prompts.

If you need a new set, create it on the **Criteria** page first. See
[Defining evaluation criteria](/guides/defining-criteria/).

## 3. Choose how to run it

You can either select a saved profile or configure the request inline.

### Use a profile

Pick a profile from the dropdown. The Portal locks the configuration
fields (worker, model, agent version, MCP servers, skills, extensions)
to the profile's latest version. To use an older version explicitly,
expand the version selector beneath the profile picker.

Selecting a profile is the only way to guarantee that another user
re-running this same combination later will get the *exact* same
configuration — see [Defining profiles](/guides/defining-profiles/).

### Configure inline

If you don't pick a profile, set the fields manually:

- **Worker** — GitHub Copilot CLI, Claude Code CLI, or VS Code Copilot.
  See [Choosing a coding agent](/guides/choosing-a-coding-agent/).
- **Model** — pick from the available models for that worker.
- **Agent version** *(optional)* — pin a specific agent build.
- **MCP servers, skills, extensions** *(optional)* — see
  [Using MCP servers, skills & extensions](/guides/mcp-skills-extensions/).

After you've configured a request inline, you can save the setup as a
profile to capture it for re-use.

## 4. Add a codebase (optional)

Select **Add codebase** when the agent should start from an existing
project. Pick a bare Git codebase to resolve its default branch at
submission time, or select a specific revision to pin the starting
workspace.

See [Managing codebases](/guides/managing-codebases/).

## 5. Submit

Click **Submit**. The Portal navigates to the request detail page.
The request is assigned a unique ID and queued; a run is created when
a worker picks it up.

## Watch a run

The request detail page has these tabs:

- **Logs** — the agent's actions stream here in real time as the worker
  executes the run.
- **Configuration** — the exact profile version (or inline
  configuration), task prompt, and criteria used. This is what makes
  the run reproducible.
- **Report** *(visible after the run completes)* — per-criterion
  pass/fail with the judge's rationale.

The status badge at the top tracks the run's lifecycle: **pending →
running → completed** (or **failed**).

## Share results

When your installation enables run sharing, click **Share** on a run to create
a configurable, read-only link for someone without a Scope account. See
[Sharing runs](/guides/sharing-runs/) for content controls, expiry, and revocation.

## Re-prioritize, pause, or resume

Pending and running requests can be reordered or paused. See
[Prioritizing & pausing requests](/guides/prioritizing-requests/).

## Re-run

From a request's detail page, click **Re-run** to create another run
on the same request — same task prompt, same criteria, same profile.
This is useful for sampling variability of an agent on the same prompt.

## Tips

- **Reproducibility** — always pick a profile when running for the
  record and pin a codebase revision when the task uses an existing
  project. Inline configurations and moving Git branches work for
  exploration but make later comparisons harder.
- **Reuse task prompts and criteria.** They're the building blocks the
  rest of Scope (prompt features, reports, MDP analyses) is keyed
  on.
- **Hidden cost** — requests that pull skills from GitHub or call MCP
  servers may take longer to start while those resources are resolved.

## Next steps

- Automate this workflow with the [REST API](/guides/submitting-requests-api/)
  or the [CLI](/guides/submitting-requests-cli/).
- Save your favorite setup as a [profile](/guides/defining-profiles/).
- Seed an existing project with a
  [codebase](/guides/managing-codebases/).
