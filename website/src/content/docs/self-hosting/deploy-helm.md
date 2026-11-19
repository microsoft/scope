---
title: Deploy with Helm
description: Install Scope's core services and ACP workers on the provisioned AKS cluster.
---

Scope is packaged as a
[Helm chart](https://helm.sh/docs/topics/charts/). The chart source is in
[`deploy/helm/scope`](https://github.com/microsoft/scope/tree/main/deploy/helm/scope).
Use it after [provisioning Azure infrastructure](/self-hosting/provision-aks/).

## Image strategy

The API, Portal, Judge, Token Manager, Scheduler, and Report Generator images
default to public packages under `ghcr.io/microsoft`. The database migration
Job uses the API Dockerfile's `builder` stage: `builder` for `latest`, or
`builder-<sha>` when `global.imageTag` is pinned.

The Copilot and Claude Code worker images are not published with the core
images. Phase 3 builds them in the provisioned ACR.

## Phase 1: generate values

```bash
./scripts/generate-values-from-bicep.sh \
  --resource-group <resource-group>
```

The script auto-detects the latest matching group deployment and writes
`my-values.yaml`. Its optional flags are:

- `--deployment-name <name>`
- `--values-file <path>`
- `--image-registry <registry>`
- `--force`

Review the generated file before installing. See
[Configuration](/self-hosting/configuration/) for application, secret,
worker, and ingress settings.

## Phase 2: install the core application

Use Helm's
[`upgrade --install`](https://helm.sh/docs/helm/helm_upgrade/) workflow to
create the release or update it in place:

```bash
helm upgrade --install scope deploy/helm/scope \
  --namespace scope \
  --create-namespace \
  -f my-values.yaml \
  --wait \
  --timeout 5m
```

The service accounts and `SecretProviderClass` are normal chart resources.
The `scope-db-migrate` Job is a `post-install,post-upgrade` hook so those
resources exist before the Job mounts Key Vault secrets. Core services can
start shortly before migration completes and use their normal transient
database retry behavior.

Agent registration is not a Helm hook.

## Phase 3: enable coding-agent workers

```bash
./scripts/bootstrap-workers.sh \
  --acr <acr-name-or-login-server> \
  --values-file my-values.yaml
```

The script:

1. Builds and pushes both ACP worker images with `az acr build`.
2. Enables their Deployments with `helm upgrade`.
3. Waits for both rollouts.
4. Registers both agent types through the API.

It does **not** register worker credentials. Add a scopeless GitHub OAuth
token and/or Anthropic API key through the Portal's **Secrets** tab or the
Token Manager API.

Run `./scripts/bootstrap-workers.sh --help` for the namespace, release,
chart, image-tag, skip-build, skip-worker, and skip-registration flags. Pass
the original `--values-file`; without it, the script falls back to
`--reuse-values`, which can omit defaults introduced after the first install.

## Verify

```bash
kubectl get pods -n scope
kubectl get jobs -n scope

kubectl -n scope port-forward svc/api 18080:80
kubectl -n scope port-forward svc/scope-portal 5100:80
```

Open <http://localhost:5100>, or use the CLI:

```bash
scope agent list --url http://localhost:18080
scope project list --url http://localhost:18080
```

To run a sample, import the reusable criteria into a project before
submitting:

```bash
scope criteria import config/criteria \
  --project <project-id> \
  --url http://localhost:18080

scope run submit \
  --scenario config/scenarios/hello-world-express-v2.yaml \
  --persona config/personas/vibe-coder.yaml \
  --worker coder-acp-copilot \
  --project <project-id> \
  --url http://localhost:18080
```

The chart's
[`SAMPLE-SCENARIO.md`](https://github.com/microsoft/scope/blob/main/deploy/helm/scope/SAMPLE-SCENARIO.md)
explains why criteria are seeded separately.

## Upgrade and rollback

Update the core images by pinning `global.imageTag` and running the same
`helm upgrade --install` command with your values file. Re-run
`bootstrap-workers.sh` to build, deploy, and register a new worker image or
agent version.

```bash
helm history scope -n scope
helm rollback scope <revision> -n scope --wait --timeout 5m
```

Prefer `-f my-values.yaml` during upgrades. Use `--reuse-values` only when
you intentionally want the release's previously computed values, including
their potentially stale defaults.

## Uninstall

```bash
helm uninstall scope -n scope
```

This removes chart-managed Kubernetes resources. It does not remove the Azure
resource group.
