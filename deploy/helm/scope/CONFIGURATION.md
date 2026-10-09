# Configuration reference

Details on values.yaml conventions and image registries. For the install
steps, see the [README](./README.md).

## Values conventions

See [`values.yaml`](./values.yaml) for the full set of configurable values.
Every service section supports:

- `enabled`
- `image.repository`, `image.tag`, `image.registry`
- `replicas`
- `resources`

`image.registry` overrides `global.imageRegistry` for a single image. The
workers use this (they pull from ACR, not GHCR), as does `jobs.dbMigrate`
(which needs a separate `:builder`-tagged image — see
`templates/jobs/db-migrate.yaml`).

## Image registry strategy

By default, the six core services (api, portal, judge, token-manager,
scheduler, report-generator) pull from `global.imageRegistry`
(`ghcr.io/microsoft` by default — public images published by
[`.github/workflows/publish-images.yml`](../../../.github/workflows/publish-images.yml)).
No registry build step is required for these.

If you publish your own fork's images, override the registry:

```bash
helm install scope deploy/helm/scope -n scope \
  -f my-values.yaml \
  --set global.imageRegistry=ghcr.io/<your-fork-owner>
```

The two ACP worker images are different — they're never published to GHCR.
`scripts/bootstrap-workers.sh` builds and pushes them to the ACR instance
`deploy/azure/` provisions. See [Workers](./WORKERS.md).

## Bring your own secrets

`deploy/azure/` pre-populates Key Vault with everything the core app
needs — Cosmos DB connection string, Redis access key, and so on. Two
secrets are bring-your-own, since they depend on your accounts, not the
infrastructure:

- `githubToken` (Key Vault secret name: `github-token`)
- `anthropicApiKey` (Key Vault secret name: `anthropic-api-key`)

The ACP workers (see [Workers](./WORKERS.md)) and the portal's GitHub
Models fallback read these directly as plain `GITHUB_TOKEN`/
`ANTHROPIC_API_KEY` env vars. Set them with:

```bash
az keyvault secret set --vault-name <keyVaultName> --name github-token --value <pat>
az keyvault secret set --vault-name <keyVaultName> --name anthropic-api-key --value <key>
```

Then restart the pods that read them, since Key Vault values only sync on
pod start:

```bash
kubectl rollout restart deployment -n scope
```

`scripts/bootstrap-workers.sh` prompts for and registers these credentials
for you — see [Workers](./WORKERS.md) for that (and a more capable
alternative through the Token Manager API).

## Not covered

Bring your own ingress controller, TLS/cert-manager, and DNS — this chart
doesn't configure any of them.
