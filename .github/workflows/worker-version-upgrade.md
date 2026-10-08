---
description: |
  Automatically assigns Copilot coding agent to version update issues created
  by the check-worker-versions workflow. Copilot reads the issue body, updates
  the versions.env file, runs integration tests, and opens a PR.

on:
  issues:
    types: [opened, edited]
    names: ["type: worker-update"]
  workflow_dispatch:
  # Workaround: gh-aw compiler bug — `names:` is commented out in the lock file
  # and no label condition is injected. Use on.steps to enforce label filtering.
  steps:
    - name: Check worker update label
      id: label_check
      if: github.event_name != 'workflow_dispatch'
      env:
        LABELS: ${{ toJSON(github.event.issue.labels.*.name) }}
      run: |
        echo "$LABELS" | grep -q '"type: worker-update"'

if: github.event_name == 'workflow_dispatch' || needs.pre_activation.outputs.label_check_result == 'success'

permissions:
  contents: read
  issues: read

network: defaults

safe-outputs:
  assign-to-agent:
    name: copilot
    target: "triggering"
    github-token: ${{ secrets.GH_AW_AGENT_TOKEN }}
---

# Worker Version Upgrade

When a version update issue is created by the check-worker-versions workflow,
apply the update and open a pull request.

## Context

Analyze the triggering issue: "${{ steps.sanitized.outputs.text }}"

The issue was created by an automated version checker. It contains a structured
body with:

- A table of components, current versions, and latest versions
- The exact `versions.env` file path to update
- The new env content to write
- Instructions to run integration tests

## Process

1. **Parse the issue** — Extract the `versions.env` file path and the new
   environment variable values from the issue body.

2. **Update the versions file** — Replace the contents of the `versions.env`
   file with the new values specified in the issue.

3. **Install dependencies** — Run `pnpm install` to ensure the workspace is
   ready.

4. **Run integration tests** — Run only the updated worker's integration tests:
   `npx vitest run --config vitest.integration.config.ts --passWithNoTests apps/workers/<worker-name>/`
   Derive `<worker-name>` from the `versions.env` path parsed in step 1.

5. **If tests fail** — Read the error output, identify the root cause, and
   attempt to fix it. Common issues include API changes in new versions that
   require code updates in the worker source files listed below.

## Workers and their version files

| Worker                | Path                                              | Env Vars                                              |
| --------------------- | ------------------------------------------------- | ----------------------------------------------------- |
| coder-acp-copilot     | `apps/workers/coder-acp-copilot/versions.env`     | `COPILOT_CLI_VERSION`                                 |
| coder-acp-claude-code | `apps/workers/coder-acp-claude-code/versions.env` | `CLAUDE_CODE_ACP_VERSION`, `CLAUDE_AGENT_SDK_VERSION` |

## Allowed source files for test fixes

If integration tests fail after a version update, only edit files in these paths:

- **coder-acp-copilot**: `apps/workers/coder-acp-copilot/src/acp-client.ts`
- **coder-acp-claude-code**: `apps/workers/coder-acp-claude-code/src/acp-client.ts`

## Constraints

- Only modify the `versions.env` file and the allowed source files listed above
- Do not modify Dockerfiles, docker-compose files, or build scripts
- The `versions.env` file is the single source of truth for version pinning
