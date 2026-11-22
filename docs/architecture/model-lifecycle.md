# Model lifecycle

Scope tracks model availability per coding agent. The model record key is
`{agentId}:{modelId}`; two agents can expose the same model independently.
The [Models page](../../apps/portal/src/pages/ModelList.tsx) shows the latest
scanner result. It defaults to active models, with a status filter for models
that have disappeared.

## Adding a model

1. A Copilot or Anthropic model scanner discovers the models available with its
   configured credential. A dry run prints the scan result without syncing it.
2. In live mode, the scanner sends each agent's discovered models to
   `POST /api/v1/models/sync`. Scope creates new model records with `firstSeenAt`
   and `lastSeenAt`; subsequent scans refresh `lastSeenAt`, metadata, and
   capabilities. A model that returns after disappearing has `disappearedAt`
   cleared.
3. The sync replaces the agent's `supportedModels` with all currently active
   models across that agent's providers. If its default model is missing, Scope
   chooses the active model with the latest provider availability date (or
   `firstSeenAt` when that date is absent).

The API validates a submitted run's model against the chosen agent's
`supportedModels`. If a model is absent, check the scanner's credential and
dry-run output, the agent's `modelProvider`, and the Models page before changing
a profile. Agent registration can set `supportedModels` directly, but a later
scanner sync reconciles that list again.

## When a model disappears

A successful sync marks models omitted from that provider's scan with
`disappearedAt` and removes them from the agent's supported-model list. Scope
retains their records and existing run history; they remain visible through the
Models page's **Disappeared** filter and `GET /api/v1/models?status=disappeared`.
If a later scan finds the same model, it becomes active again.

New submissions using an unavailable model fail validation. The submission
preflight also checks `disappearedAt`: if the agent's supported-model list has
not yet caught up, it warns during the first 24 hours and rejects after that
with `model_unavailable_for_worker`. A pinned profile or rerun may therefore
need a different model before it can be submitted again. Scope does not
automatically rewrite a profile's selected model.

`providerEndOfLife` is provider-supplied metadata shown on the model detail
page. It is not a scheduled removal switch: the scanner's observed availability
determines the active/disappeared state. There is currently no separate
"deprecated" state or automatic advance notice. For a planned provider
retirement, review affected profiles, select a supported replacement, and
compare benchmark results before the old model disappears.

## Where to check

- Portal: **Models** for active/disappeared status and first/last seen dates;
  **Model detail** for provider availability and end-of-life dates.
- API: `GET /api/v1/models?agentId=<agentId>&status=active` (or
  `status=disappeared`) and `GET /api/v1/models/<agentId>:<modelId>`.
- Implementation: [sync route](../../apps/api/src/routes/models.ts),
  [submission validation](../../apps/api/src/routes/requests/index.ts), and
  [model scanners](../../apps/model-scanners/).
