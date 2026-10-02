---
title: Model lifecycle and deprecation
description: How Scope discovers new coding-agent models, handles provider deprecations, and treats models that disappear.
---

Scope does not maintain a permanent hand-written list of coding-agent models.
For providers that support model discovery, **model scanners** periodically ask
the provider what is available and reconcile that result with Scope's model
catalog.

This means the model list can change independently of a Scope release. A new
provider model can appear after a scan, and a retired model can disappear after
the provider stops advertising it.

## Lifecycle at a glance

A model normally moves through these states:

1. **Discovered** — a scanner sees the model for the first time.
2. **Active** — later scans continue to return it.
3. **Planned for retirement** *(when the provider supplies a date)* — Scope
   records the provider's end-of-life/deprecation date, but the model remains
   active while the provider still advertises it.
4. **Disappeared** — a scan no longer returns a model that Scope previously
   saw.
5. **Restored** — if the provider advertises a disappeared model again, Scope
   clears the disappearance marker and treats the model as active again.

Scope keeps lifecycle history rather than deleting the model record. This lets
older runs retain the model ID they actually used.

## How new models are added

Each provider scanner returns a model ID and, when available, metadata such as:

- the provider-reported availability date;
- the provider-reported end-of-life/deprecation date;
- model capabilities such as supported reasoning-effort levels, tool calling,
  vision, streaming, or adaptive thinking.

The scanner sends that inventory to Scope's model-sync API. A model Scope has
never seen before is inserted with a `firstSeenAt` timestamp. Models already in
the catalog get their `lastSeenAt` timestamp and provider metadata refreshed.

After reconciliation, the coding agent's `supportedModels` list is rebuilt from
models that are currently active. Request validation uses that agent-specific
list when checking an explicitly selected model.

The Portal gets model capability and selection data separately from the model
catalog by querying `GET /api/v1/models` for the selected agent with
`status=active`. That active-catalog query does not consume the agent's
`supportedModels` field.

### Default model changes

If an agent has no default model, or its current default is no longer active,
Scope automatically selects the newest active model. "Newest" is determined by
the provider availability date when supplied, otherwise by the time Scope first
saw the model.

A model appearing in the catalog therefore does **not** necessarily change the
default immediately. The automatic default selection happens when a default is
missing or has disappeared.

## What happens when a model is deprecated

Providers do not all expose deprecation information in the same way. When a
scanner receives a planned end-of-life date, Scope stores it as
`providerEndOfLife`. That date is informational lifecycle metadata; Scope does
not remove the model merely because the date exists.

Actual availability is determined by provider discovery. Once a previously
active model is absent from a scan, Scope records `disappearedAt` and removes it
from the agent's active `supportedModels` list.

This distinction matters because a provider may announce retirement before the
model stops working, or temporarily omit a model from discovery.

## Submission behavior after a model disappears

Request submission first validates the selected model against the coding
agent's current `supportedModels` list. Because reconciliation removes
disappeared models from that list, a reconciled request can be rejected at this
step with `agent_model_unsupported`.

If the model still passes that agent-target validation, the request route also
checks the model catalog's `disappearedAt` timestamp:

- **Less than 24 hours since `disappearedAt`:** submission is allowed, but the
  request receives a warning that the model may not be available at runtime.
- **24 hours or more since `disappearedAt`:** submission is rejected with
  `model_unavailable_for_worker`.

The 24-hour check is therefore a secondary safety net, not a guarantee that
every disappeared model remains submittable for 24 hours. In the common case
where agent reconciliation has already removed the model from
`supportedModels`, the earlier agent-target validation rejects it first.

If the model reappears in a later provider scan, its `disappearedAt` marker is
cleared and it returns to the active model catalog and agent reconciliation can
restore it to `supportedModels`.

## What users should expect

### Portal and inline submissions

Portal model capability and model-selection data comes from the active model
catalog for the selected coding agent. Once a model is no longer active, it
drops out of that catalog query.

Submission is validated independently against the agent's
`supportedModels`. Historical configuration can still reference an older
model, but a new request using it may be rejected by agent-target validation.
Only models that pass that validation reach the later `disappearedAt`
warning/rejection check described above.

### Profiles

Profiles are versioned configuration records, so an older profile version can
still name a model that has since disappeared. Keeping that historical value is
important for reproducibility: Scope should not silently rewrite what an old
benchmark was configured to use.

When you create new runs, prefer an active model. If a long-lived benchmark
profile points at a retired model, create a new profile version with its
replacement instead of changing the meaning of the historical version.

### Existing runs and reports

Existing run records keep the model ID that was used at execution time. Model
retirement does not rewrite completed run history or reports.

This is why lifecycle records are marked as disappeared instead of being
removed from the database.

## Operator checklist for rotating models

When a provider introduces or retires a model:

1. Run or wait for the relevant provider scanner.
2. Verify the model catalog (`GET /api/v1/models`) shows the expected active or
   disappeared state.
3. Check the affected coding agent's `supportedModels` and `defaultModel`.
4. Review `providerEndOfLife` dates where the provider supplies them.
5. Update benchmark profiles that should move to a replacement model by
   creating new profile versions.
6. Keep historical runs/profile versions unchanged so comparisons remain
   traceable.

## See also

- [Choosing a coding agent](/guides/choosing-a-coding-agent/)
- [Defining profiles](/guides/defining-profiles/)
- [Submitting requests from the Portal](/guides/submitting-requests-portal/)
- [Coding agents & capabilities](/reference/workers/)
