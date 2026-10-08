---
title: REST API overview
description: Overview of the Scope REST API and pointer to the auto-generated endpoint reference.
---

The Scope REST API mirrors what you can do in the Portal and the
`scope` CLI. The full per-endpoint reference is **auto-generated from
the committed OpenAPI snapshot** and lives under
[REST API reference](/reference/api/).

For interactive exploration, your deployment may provide Swagger UI and
a raw OpenAPI document:

- **Swagger UI**: `https://your-scope.example.com/api-docs`
- **Raw spec**: `https://your-scope.example.com/openapi.json`

This page is a high-level map of the resource groups, with links to
the relevant user guides.

## Access

Use the authentication method configured for your deployment. See
[Access](/getting-started/access/) for details.

## Resource groups

### Requests

The top-level submission resource. A request bundles a task prompt,
criteria, and a profile (or inline runtime config). Each request has
one or more **runs**; run state lives on the request.

Key operations: create, list, get, stream logs, bulk-resubmit
(retry), soft-delete.

See [Submitting requests (REST API)](/guides/submitting-requests-api/) and
[Prioritizing & pausing requests](/guides/prioritizing-requests/).

### Task prompts

The shared catalog of task prompts, de-duplicated by text. CRUD plus
prompt-feature extraction.

See [Managing task prompts](/guides/managing-task-prompts/).

### Criteria

Reusable criteria, organized as a DAG (`dependsOn` edges between
criteria). CRUD.

See [Defining evaluation criteria](/guides/defining-criteria/) and
[Criteria schema](/reference/criteria-schema/).

### Profiles

Versioned agent runtime configurations. Identity is mutable, each
version is immutable.

See [Defining profiles](/guides/defining-profiles/) and
[Profile schema](/reference/profile-schema/).

### Prompt features

The shared feature catalog plus AI-assisted prompt generation and
per-task-prompt extraction.

See [Working with prompt features](/guides/prompt-features/) and
[Prompt feature schema](/reference/prompt-feature-schema/).

### Reports

Generate and fetch per-request evaluation reports.

### Other resources

The API also exposes `agents`, `models`, `mcp-servers`, `skills`,
`extensions`, `insights`, and `report-templates`. See the generated
[REST API reference](/reference/api/) for endpoint-level
details.

## Request status & outcome

Every request has a `status` (where it is in the lifecycle) and,
once it reaches `done`, an `outcome` (how it finished).

| Status | Meaning |
| --- | --- |
| `pending` | Just submitted; the scheduler has not picked it up yet. |
| `queued` | The scheduler placed it on a worker queue. |
| `processing` | A worker has dequeued it and is executing the run. |
| `paused` | Manually paused by a user. Can be resumed. |
| `done` | Terminal. Inspect `outcome` for the result. |

| Outcome | Meaning |
| --- | --- |
| `succeeded` | The agent completed the task and the run finished cleanly. |
| `failed` | The run failed (worker error, agent error, timeout, etc.). |
| `finished` | The run completed but without a clear pass/fail signal. |

Worker types accepted by the API:

- `coder-acp-copilot`
- `coder-acp-claude-code`

## Refreshing this reference

The per-endpoint reference is built from a committed artifact at
`src/openapi/scope-openapi.json`, generated from scope-core's API
registry. To refresh it after changing API routes or schemas:

```sh
pnpm run refresh:openapi
```

The command does not contact a deployed environment. It overwrites the
snapshot from the checked-out source. Commit the result to update the
published reference.

## See also

- [REST API reference (auto-generated)](/reference/api/)
- [Submitting requests (REST API)](/guides/submitting-requests-api/)
