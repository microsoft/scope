---
title: Configuration
description: Chart values, secrets, sign-in, workers, and optional components for a self-hosted Scope deployment.
---

The Scope chart reads all settings from Helm values. The same values work
for `helm install` and for a Flux `HelmRelease`; only where you write them
differs:

| Path | Where values live |
| --- | --- |
| [Helm](/self-hosting/deploy-helm/) | your values file, passed with `--values` |
| [Flux](/self-hosting/deploy-flux/) | `spec.values` and `spec.valuesFrom` in the `HelmRelease` |

The full list of values, with defaults and comments, is in
[deploy/helm/scope/values.yaml](https://github.com/microsoft/scope/blob/main/deploy/helm/scope/values.yaml).
This page covers the values you're most likely to change.

## Core values

| Value | Default | Purpose |
| --- | --- | --- |
| `image.registry` | — | Registry host, for example `myacr.azurecr.io`. Required. |
| `image.repositoryPrefix` | `scoped` | Path prefix for every image. |
| `image.tag` | chart `appVersion` | Image tag for every component. Use an immutable tag. |
| `azure.tenantId` | — | Entra tenant of the workload identities. |
| `azure.keyVault.uri` | — | Key Vault that holds the secrets. |
| `azure.workloadIdentity.externalSecretsClientId` | — | Identity that reads Key Vault for External Secrets. |
| `azure.workloadIdentity.tokenManagerClientId` | — | Identity the token manager uses to write agent tokens. |
| `azure.storage.accountName` | — | Storage account for queues and blobs. |
| `azure.storage.accountArmId` | — | Resource ID, used by Azure Service Operator. |
| `azure.cosmosDb.accountArmId` | — | Resource ID, used by Azure Service Operator. |
| `mongo.database` | `scoped` | Database name. |

[Provision AKS](/self-hosting/provision-aks/#outputs) produces every
`azure.*` value.

## Secrets

The chart never takes secrets as values. Secrets live in Azure Key Vault,
and the [External Secrets Operator](https://external-secrets.io/) copies
them into Kubernetes Secrets in the `scoped` namespace. A
`ClusterSecretStore` named `azure-keyvault` authenticates to Key Vault
with workload identity.

| Kubernetes Secret | Key Vault secrets | Used by |
| --- | --- | --- |
| `mongo-secrets` | `mongo-connection-string` | API, Judge, migrations |
| `redis-secrets` | `redis-host`, `redis-port`, `redis-password` | API, Judge |
| `storage-secrets` | `storage-connection-string` | API, Judge, KEDA |
| `appinsights-secrets` | `appinsights-connection-string` | all services |
| `worker-secrets` | the Mongo, Redis, storage, and App Insights keys combined | workers |
| `azure-ai-inference-secrets` | `azure-ai-inference-endpoint`, `azure-ai-inference-api-key` | Portal AI features |
| `github-models-secrets` | `github-models-api-key` | Portal AI features (fallback) |

Provisioning writes the infrastructure secrets: Mongo, Redis, storage,
and App Insights. You add the others yourself.

### Secrets you supply

| Key Vault secret | Required | Purpose |
| --- | --- | --- |
| `github-copilot-pat` | for the Copilot worker | Token the token manager hands to Copilot workers. |
| `anthropic-api-key` | for the Claude Code worker | Anthropic API key. |
| `azure-ai-inference-endpoint`, `azure-ai-inference-api-key` | no | Model for Portal AI features. |
| `github-models-api-key` | no | Alternative model for Portal AI features. |

Set a secret with the Azure CLI:

```bash
az keyvault secret set --vault-name <vault> \
  --name anthropic-api-key --value "<key>"
```

To set a secret from a file, pass `--file <path>` instead of `--value`.
Writing secrets requires the **Key Vault Secrets Officer** role on the
vault.

External Secrets refreshes every 5 minutes. Pods restart automatically
when a Secret changes, so a rotated value reaches the services within
minutes, without a redeploy. The token manager reads agent tokens from
Key Vault directly and picks up changes on its own schedule.

### Without External Secrets

To manage secrets another way, set `externalSecrets.enabled: false` and
create the Secrets from the table above in the `scoped` namespace
before installing. Keep the same Secret names and keys.

## Authentication

Sign-in is **off** by default: anyone who can reach the Portal or the API
uses Scope anonymously. Turn on Microsoft Entra ID sign-in for any
deployment others can reach.

1. Register two Entra applications, or let
   [provisioning create them](/self-hosting/provision-aks/#authentication):
   an **API** app that exposes the `access_as_user` scope, and a **Portal**
   single-page app that requests it.
2. Build the Portal image with the SPA settings, because the Portal reads
   them at build time:

   ```bash
   az acr build --registry "$ACR" --image "scoped/portal:$TAG" \
     --build-arg VITE_AUTH_CLIENT_ID="<portal-client-id>" \
     --build-arg VITE_AUTH_AUTHORITY="https://login.microsoftonline.com/<tenant-id>" \
     --build-arg VITE_AUTH_SCOPES="api://<api-client-id>/access_as_user" \
     --file apps/portal/Dockerfile .
   ```

3. Enable sign-in in the values:

   ```yaml
   auth:
     entra:
       enabled: true
       authority: https://login.microsoftonline.com/<tenant-id>
       apiClientId: <api-client-id>
   ```

   The chart then sets `AUTH_PROVIDER=entra`, `AUTH_AUTHORITY`, and
   `AUTH_API_CLIENT_ID` on the API and `SCOPE_AUTH_ENABLED=true` on the
   Portal.

4. Add the Portal's public URL as a redirect URI on the SPA registration.

See [Access](/getting-started/access/) for how users reach Scope, and
[ENV_VARIABLES.md](https://github.com/microsoft/scope/blob/main/ENV_VARIABLES.md)
for every authentication setting.

## Workers

Each worker is a Deployment that consumes one Azure Storage queue,
`queue-<worker>`. [KEDA](https://keda.sh/) scales it from zero on queue
length, so idle workers cost nothing.

```yaml
workers:
  coder-acp-copilot:
    enabled: true
    maxReplicas: 10
  coder-acp-claude-code:
    enabled: true
    maxReplicas: 5
  coder-acp-copilot-windows:
    enabled: false
  post-processor:
    enabled: true
  report-generator:
    enabled: true
```

| Setting | Default | Effect |
| --- | --- | --- |
| `enabled` | `true` (Windows: `false`) | Deploys the worker and its registration Job. |
| `minReplicas` | `0` | Warm replicas kept when the queue is empty. |
| `maxReplicas` | `10` | Upper bound on parallel tasks for that worker. |
| `queueLength` | `1` | Messages per replica before KEDA adds another. |

KEDA checks queues every 15 seconds and scales back to zero 60 seconds
after a queue empties. Worker pods run on the `workers` node pool, which
autoscales too, so the first task after an idle period waits for a node
to start.

`maxReplicas` across all workers should fit the `workers` pool's maximum
node count. Raise both together. Each coding-agent worker requests 250m
CPU and 1 GiB of memory.

For what each worker does, see [Workers](/reference/workers/).

### Windows workers

`coder-acp-copilot-windows` runs on Windows nodes. Enable it only on a
cluster with a Windows node pool (`DEPLOY_WINDOWS_CLUSTER=true`, which
needs `AKS_NETWORK_POLICY=calico`), and publish its image from a Windows
build host.

## Optional components

### Container access for agents (Kubedock)

Some tasks need the agent to run `docker build` or `docker run`. Enable
[Kubedock](https://github.com/joyrex2001/kubedock) to add a sidecar to the
coding-agent workers that turns Docker API calls into pods in the
`scoped` namespace, with no privileged containers:

```yaml
kubedock:
  enabled: true
```

The chart adds the sidecar, a ServiceAccount, and a Role that allows
creating pods. See
[Kubedock](https://github.com/microsoft/scope/blob/main/docs/architecture/kubedock.md)
for the design.

### OpenTelemetry collector

By default each service sends telemetry straight to Application Insights.
Enable the collector to route all traces, metrics, and logs through one
gateway instead:

```yaml
otelCollector:
  enabled: true
```

Services detect the collector and switch to OTLP export. The collector
exports to Azure Monitor with the `appinsights-secrets` connection
string. See
[Observability](https://github.com/microsoft/scope/blob/main/docs/architecture/observability.md).

### Azure Service Operator resources

With `azureServiceOperator.enabled: true` (the default), the chart creates
the storage queues, blob containers, and the MongoDB database and
collections as Kubernetes resources. Indexes come from the migration Job,
not the chart. Set it to `false` if you create these resources another
way, for example with your own IaC.

## Expose the Portal

The `portal` Service is `ClusterIP` by default. Choose one of these:

- **Port-forward**: for a first look; see
  [Verify](/self-hosting/deploy-helm/#4-verify).
- **Ingress with TLS**: recommended. AKS
  [application routing](https://learn.microsoft.com/azure/aks/app-routing)
  provides a managed NGINX ingress class, and cert-manager, installed by
  provisioning, issues the certificate:

  ```yaml
  portal:
    ingress:
      enabled: true
      className: webapprouting.kubernetes.azure.com
      host: scope.example.com
      tls:
        clusterIssuer: letsencrypt-prod
  ```

  Create the `ClusterIssuer` once, and point your DNS name at the
  ingress's public IP.
- **LoadBalancer**: `portal.service.type: LoadBalancer`. Add the
  `service.beta.kubernetes.io/azure-load-balancer-internal: "true"`
  annotation under `portal.service.annotations` to keep the address on
  your virtual network.

The Portal proxies `/api` to the API service, so only the Portal needs
to be exposed. The REST API is served from the same host under
`/api/v1`, so CLI users set `SCOPE_API_URL` to the Portal URL.

## Database

`mongo.database` sets the database name. Collections and their indexes
are created by the chart and by migrations, so don't create indexes by
hand. Azure Cosmos DB for MongoDB supports a subset of MongoDB, and the
migrations are written for that subset.
