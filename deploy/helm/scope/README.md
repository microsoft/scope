# Scope Helm chart

Deploys the Scope application onto the AKS cluster that
[`deploy/azure/`](../azure/README.md) provisions.

| Phase | What it does | Tooling |
|---|---|---|
| 1. Infrastructure | AKS, Cosmos DB, Key Vault, Redis, Storage, ACR, networking | `deploy/azure/` (Bicep) |
| 2. Core app | api, portal, judge, token-manager, scheduler, report-generator | This chart |
| 3. Coding-agent workers | Worker images, agent registration | `scripts/bootstrap-workers.sh` |

This README covers phases 2 and 3.

## Prerequisites

- Phase 1 infrastructure already deployed (AKS with Key Vault Secrets
  Provider CSI driver + workload identity, Key Vault, Storage, Cosmos DB,
  Redis, ACR).
- `helm` and `kubectl`, configured against the target cluster.

## Phase 2: Deploy the core app

**1. Get a values file.** Deployed via `deploy/azure/`'s Bicep:

```bash
./scripts/generate-values-from-bicep.sh --resource-group <resource-group-name>
```

Otherwise, hand-author `my-values.yaml` — see [Configuration](./CONFIGURATION.md).

**2. Install the chart:**

```bash
helm upgrade --install scope deploy/helm/scope \
  --namespace scope --create-namespace \
  -f my-values.yaml \
  --wait --timeout 5m
```

**3. Add any bring-your-own secrets** (GitHub token, Anthropic API key)
Bicep doesn't provision — see
[Bring your own secrets](./CONFIGURATION.md#bring-your-own-secrets).

## Phase 3: Bring workers online

ACP coding-agent workers are disabled by default:

```bash
./scripts/bootstrap-workers.sh --acr <acrName>
```

Builds + pushes both worker images, enables their Deployments, and
registers both agents with the API. Register the GitHub token/Anthropic
API key they need yourself via the Portal's **Secrets** tab (or
`POST /api/v1/keys`) — see [Workers](./WORKERS.md) for flags and details.

## Verify

```bash
kubectl get pods -n scope

# No ingress yet — reach services via port-forward.
kubectl -n scope port-forward svc/api 18080:80 &
kubectl -n scope port-forward svc/scope-portal 5100:80 &

scope agent list --url http://localhost:18080   # or open http://localhost:5100
```

Then try an end-to-end run — see [Run a sample scenario](./SAMPLE-SCENARIO.md).

## Learn more

- [Configuration reference](./CONFIGURATION.md) — values.yaml conventions,
  image registry strategy, secrets options
- [Workers](./WORKERS.md) — bootstrapping the ACP coding-agent workers
- [Run a sample scenario](./SAMPLE-SCENARIO.md) — seed criteria and submit
  a run
- [`values.yaml`](./values.yaml) — every configurable value
- [Bicep infrastructure README](../azure/README.md)
