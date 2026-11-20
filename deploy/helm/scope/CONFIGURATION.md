# Configuration reference

Details on values.yaml conventions and image registries. For the install
steps, see the [README](./README.md).

## Bring your own secrets

Port-forward the Portal if it isn't already running (see README "Verify"):

```bash
kubectl -n scope port-forward svc/scope-portal 5100:80
```

Then, at <http://localhost:5100>:

1. Go to the **Secrets** tab.
2. Click **Register key**.
3. Add your GitHub token and Anthropic API key.

> See [Workers](./WORKERS.md#registering-credentials-another-way) for other
> ways to register these credentials (a raw Key Vault secret, or the API
> directly).

### GitHub OAuth token for the Copilot worker

The `coder-acp-copilot` worker needs a scopeless GitHub OAuth token (not a
personal access token). Generate one with:

```bash
pnpm get-copilot-token
```

Follow the device-code prompt to approve access, then register the printed
token as the GitHub secret key in the Portal's **Secrets** tab above.

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

## Not covered

Bring your own ingress controller, TLS/cert-manager, and DNS — this chart
doesn't configure any of them.
