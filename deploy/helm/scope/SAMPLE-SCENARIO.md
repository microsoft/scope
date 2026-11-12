# Run a sample scenario

Once the core app and at least one [worker](./WORKERS.md) are up, try an
end-to-end run.

## Why you need to seed criteria first

Scenarios and personas (`config/scenarios/`, `config/personas/`) aren't
server-side data — `scope run submit --scenario <path> --persona <path>`
reads them straight off disk, so there's nothing to import for those.

Criteria are different: they're server-side and project-scoped. Several
scenarios (the `version: v2` ones) reference reusable criteria IDs like
`has_react`/`has_typescript` instead of inlining their own, and those IDs
must exist in the target project before the judge can evaluate a run
against them.

This seed step isn't a Helm hook. Unlike `db-migrate`, it's project-scoped
business data, not infrastructure, and no project exists until the
`db-migrate` Job's "Initial Project" migration has run. Baking a project
assumption into the chart would surprise anyone bringing their own
projects — so run it yourself, once.

## Steps

```bash
kubectl -n scope port-forward svc/api 18080:80 &

# Find the project to seed into: the "Initial Project" created by
# db-migrate on first install, or one of your own.
scope project list --url http://localhost:18080

# Import every reusable criterion. This is an upsert, so it's safe to rerun.
scope criteria import config/criteria --project <project-id> --url http://localhost:18080

# Submit the simplest sample scenario.
scope run submit \
  --scenario config/scenarios/hello-world-express-v2.yaml \
  --persona config/personas/vibe-coder.yaml \
  --worker coder-acp-copilot \
  --project <project-id> \
  --url http://localhost:18080
```

`--worker` must be an agent ID registered in [Workers](./WORKERS.md) —
check with `scope agent list --url http://localhost:18080`.

`hello-world-express-v2.yaml` only needs `has_azure_doc`/`has_azure_azd`
(plus their `has_iac`/`has_azure`/`has_cloud` ancestors). Importing the
whole `config/criteria` directory is simpler than cherry-picking a
dependency closure, and it covers every sample scenario, including
`react-snake-game-v2.yaml`.
