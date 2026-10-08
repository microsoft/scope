---
title: Troubleshooting
description: Common problems with Scope and how to fix them.
---

## I can't reach the Portal

- Confirm that you are using the Portal URL and authentication method
  provided for your deployment.
- Check your browser's network errors to confirm that the deployment URL
  is reachable.
- Still stuck? Capture the error from the browser DevTools
  **Network** tab and contact your Scope administrator.

## My request is stuck in `pending`

A request stays pending while it's waiting for worker capacity.

- **Bump the priority** (range −10 to +10). See
  [Prioritizing & pausing requests](/guides/prioritizing-requests/).
- Check the Portal dashboard for capacity issues.
- If pending for hours with capacity available, the worker pool may
  be unhealthy — contact your administrator.

## My run is stuck in `processing`

- Open the request's **Logs** tab. If the agent is still producing
  output, it's working — give it time, especially with the VS Code
  Electron worker.
- If logs are silent for an unusually long time, the agent may be
  blocked on input or stuck in a tool loop. Cancel and re-submit, or
  pause/resume.
- For repeatable hangs, file an issue with your administrator,
  including the request ID and worker.

## Profile creation fails with HTTP 400 — extensions

Extensions are only accepted by the **VS Code Copilot** coding
agents return HTTP 400 if you try to attach extensions.

Either:

- Remove `extensions` from the profile, or
- Switch the profile's `workerType` to

See [Choosing a coding agent](/guides/choosing-a-coding-agent/) and
[Defining profiles](/guides/defining-profiles/).

## Profile creation hangs on save

If you supplied skill paths or extension IDs without versions, MS
Scope is resolving them — skill paths to commit hashes, extensions
to Marketplace versions. This may take a few seconds. Pre-pin them
to skip the resolution step.

## Prompt feature extraction returns HTTP 503

The LLM service powering feature detection (and AI-assisted
generation) is unavailable or rate-limited. Wait a moment and retry,
or re-trigger from the Portal. See
[Working with prompt features](/guides/prompt-features/#limitations).

## My report shows a criterion as failed but the work looks correct

- Open the criterion in the report and read the judge's rationale.
  The judge may be looking for evidence that's present in a different
  form than expected.
- Edit the criterion's `text` to be more precise, or override its
  evaluation prompt. See
  [Defining evaluation criteria](/guides/defining-criteria/).
- For DAG criteria, check whether a parent criterion failed —
  children won't be evaluated in that case.

## Two runs on the same request produced different results

This is expected. AI agents are stochastic. To compare profiles
fairly, run several attempts and compare aggregate pass rates rather
than single runs.

If results vary *wildly*, double-check that:

- The profile **version** is the same (the identity may have moved
  to a new version under you).
- `agentVersion` is pinned in both runs.
- Skill and extension references are pinned to specific
  commits/versions.

## See also

- [FAQ](/resources/faq/)
- [Glossary](/resources/glossary/)
- [Self-hosting operations](/self-hosting/operations/#troubleshoot) for
  Kubernetes deployment problems
