# Scope Helm chart

Deploys the Scope application onto the AKS cluster that
[`deploy/azure/`](../azure/README.md) provisions.

Getting Scope running is three phases:

| Phase | What it does | Tooling |
|---|---|---|
| 1. Infrastructure | AKS, Cosmos DB, Key Vault, Redis, Storage, ACR, networking | `deploy/azure/` (Bicep) |
| 2. Core app | api, portal, judge, token-manager, scheduler, report-generator | This chart |
| 3. Coding-agent workers | Build worker images, register secrets and agents | `scripts/bootstrap-workers.sh` |

This README covers phases 2 and 3. For infrastructure, see the
[Bicep README](../azure/README.md).

## Prerequisites

- Azure infrastructure from `deploy/azure/`, already deployed. It
  provisions everything phase 2 needs: an AKS cluster with the Key Vault
  Secrets Provider CSI driver and workload identity enabled, a federated
  managed identity, and Key Vault/Storage/Cosmos DB/Redis.
- `helm` and `kubectl`, configured against the target cluster.

## Deploy the core app

1. Get the Bicep deployment's outputs:

   ```bash
   az deployment group show \
     --resource-group <resource-group-name> \
     --name <deployment-name> \
     --query properties.outputs -o json
   ```

2. Create a values file from those outputs:

   ```yaml
   # my-values.yaml
   azure:
     tenantId: <tenantId>
     keyVaultName: <keyVaultName>
     keyVaultUri: <keyVaultUri>
     workloadIdentityClientId: <workloadIdentityClientId>
     serviceAccountName: <workloadIdentityServiceAccountName>
     storageAccountName: <storageAccountName>
     redisHostName: <redisHostName>

   api:
     ingress:
       enabled: true
       host: api.example.com

   portal:
     ingress:
       enabled: true
       host: app.example.com
   ```

3. Install the chart:

   ```bash
   kubectl create namespace scope
   helm install scope deploy/helm/scope -n scope -f my-values.yaml
   ```

   Images come from `ghcr.io/microsoft` by default. To use your own fork's
   published images instead, add
   `--set global.imageRegistry=ghcr.io/<your-fork-owner>`.

   Database migrations run automatically as part of the install.

4. Add any bring-your-own secrets (GitHub token, Anthropic API key) that
   Bicep doesn't provision. See
   [Bring your own secrets](./CONFIGURATION.md#bring-your-own-secrets) for
   your options.

## Bring workers online

The ACP coding-agent workers are disabled by default. Enable them with:

```bash
./scripts/bootstrap-workers.sh --acr <acrName>
```

This builds and pushes both worker images, prompts for their credentials,
enables their Deployments, and registers both agent types with the API.
See [Workers](./WORKERS.md) for details and script flags.

## Verify

```bash
kubectl get pods -n scope

# Port-forward the API so the CLI can reach it without an ingress.
kubectl -n scope port-forward svc/api 18080:80 &
scope agent list --url http://localhost:18080
```

No ingress yet? Reach the portal the same way:

```bash
kubectl -n scope port-forward svc/scope-portal 5100:80 &
```

Then open <http://localhost:5100>.

Then try an end-to-end run — see
[Run a sample scenario](./SAMPLE-SCENARIO.md).

## Learn more

- [Configuration reference](./CONFIGURATION.md) — values.yaml conventions,
  image registry strategy, secrets options
- [Workers](./WORKERS.md) — bootstrapping the ACP coding-agent workers
- [Run a sample scenario](./SAMPLE-SCENARIO.md) — seed criteria and submit
  a run
- [`values.yaml`](./values.yaml) — every configurable value
- [Bicep infrastructure README](../azure/README.md)
