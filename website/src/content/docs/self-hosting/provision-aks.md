---
title: Provision AKS
description: Provision Azure Kubernetes Service and Scope's backing Azure services with the Azure Developer CLI and Bicep.
---

The [infra/aks](https://github.com/microsoft/scope/tree/main/infra/aks)
folder is an [Azure Developer CLI](https://learn.microsoft.com/azure/developer/azure-developer-cli/overview)
(`azd`) project. One `azd up` creates an AKS cluster, the managed services
Scope needs, the identities that connect them, and the cluster add-ons
the Helm chart relies on. When it finishes, continue with
[Deploy with Helm](/self-hosting/deploy-helm/) or
[Deploy with Flux](/self-hosting/deploy-flux/).

## Prerequisites

| Tool or access | Notes |
| --- | --- |
| [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) (`az`) | Signed in to the target tenant |
| [Azure Developer CLI](https://learn.microsoft.com/azure/developer/azure-developer-cli/install-azd) (`azd`) | Version 1.15.0 or later |
| [kubectl](https://kubernetes.io/docs/tasks/tools/) and [kubelogin](https://azure.github.io/kubelogin/install.html) | Cluster access uses Microsoft Entra ID |
| [Helm](https://helm.sh/docs/intro/install/) 3 | Used by the provisioning hook to install add-ons |
| Bash | The hooks are Bash scripts |
| Azure role | **Owner** on the subscription, or **Contributor** plus **User Access Administrator**. Provisioning creates role assignments. |
| Entra app registrations | An API and a Portal registration, if you enable sign-in. See [Authentication](#authentication). |

Choose a region that offers AKS, Azure Cosmos DB, Azure Managed Redis, Key
Vault, and Storage, ideally with three availability zones. To list regions
with zone support:

```bash
az account list-locations \
  --query "sort_by([? availabilityZoneMappings != null], &name)[].name" \
  --output table
```

## Provision

```bash
cd infra/aks
azd auth login
az login
azd up
```

`azd` prompts for an **environment name** (used to name resources), a
**subscription**, and a **location**. Set any of the
[environment variables](#configuration) with `azd env set` before you run
`azd up` to change the defaults.

`azd up` runs three stages:

1. **`preprovision` hook** registers the Azure resource providers the
   deployment uses (`Microsoft.ContainerService`, `Microsoft.DocumentDB`,
   `Microsoft.Cache`, `Microsoft.KeyVault`, `Microsoft.Storage`, and others).
2. **Bicep deployment** creates the resource group and all Azure resources
   from `main.bicep`.
3. **`postprovision` hook**:
   - grants the AKS cluster identity **Network Contributor** on the
     virtual network;
   - fetches cluster credentials;
   - installs the cluster add-ons with Helm (see [Cluster add-ons](#cluster-add-ons));
   - when `DEPLOY_FLUX=true`, installs Flux and writes the `infra-outputs`
     ConfigMap that the Flux path reads (see
     [Deploy with Flux](/self-hosting/deploy-flux/)).

To re-run only the Bicep deployment and hooks later, use `azd provision`.
To preview changes without applying them, use `azd provision --preview`.

## What gets created

| Module | Resources |
| --- | --- |
| `networking.bicep` | Virtual network with an AKS subnet and a private endpoint subnet |
| `private-dns.bicep` | Private DNS zones for each enabled service, linked to the virtual network |
| `kubernetes.bicep` | AKS cluster, node pools, optional Azure Container Registry with `AcrPull` for the cluster |
| `keyvault.bicep` | RBAC-enabled Key Vault behind a private endpoint, pre-populated with connection secrets |
| `cosmosdb.bicep` | Azure Cosmos DB account (MongoDB API by default) behind a private endpoint |
| `redis.bicep` | Azure Managed Redis behind a private endpoint |
| `storage.bicep` | Storage account for queues and blobs, with private endpoints for both |
| `workloadidentity.bicep` | User-assigned managed identities with federated credentials for Kubernetes service accounts |
| `aso-identity.bicep` | Managed identity for Azure Service Operator, limited to queue and Cosmos DB management |
| `observability.bicep` | Log Analytics, Azure Monitor workspace, Application Insights, and managed Grafana |
| `action-group.bicep`, `alert-rules.bicep` | Alert rules and an action group for email or webhook notifications |
| `servicebus.bicep` | Azure Service Bus (optional, off by default) |
| `openai.bicep` | Azure OpenAI with model deployments (optional, off by default) |

All data services are reachable only through private endpoints in the
virtual network.

### AKS cluster

The cluster uses Azure CNI Overlay, an OIDC issuer, and workload identity.
The network policy engine is Cilium by default. Node pools autoscale and
are spread across the configured availability zones:

| Pool | OS | Label | Taint | Size | Runs |
| --- | --- | --- | --- | --- | --- |
| `system` | Linux | `kubernetes.azure.com/mode: system` | `CriticalAddonsOnly=true:NoSchedule` | 3–5 | Cluster add-ons, migration Job |
| `apps` | Linux | `scoped/workload-type: app` | `scoped/workload-type=app:NoSchedule` | 2–4 | API, Portal, Judge, gateway, scheduler, token manager |
| `workers` | Linux | `scoped/workload-type: workers` | none | 0–5 | Linux coding workers |
| `winwrk` | Windows Server 2022 | `scoped/workload-type: workers-windows` | `os=windows:NoSchedule` | 0–5 | Windows coding worker (optional) |

The `apps` pool never scales to zero, so a busy worker can't starve the
API or the Portal. The `workers` pool scales to zero when no runs are
queued. The Helm chart already sets the matching node selectors and
tolerations.

### Identities and roles

| Identity | Used by | Access |
| --- | --- | --- |
| Workload identity for secrets | External Secrets Operator | **Key Vault Secrets User** |
| Workload identity for tokens | `token-manager` | **Key Vault Secrets Officer**, to store and rotate agent tokens |
| ASO identity | Azure Service Operator | Queue and Cosmos DB management on the storage and database accounts |
| AKS kubelet identity | Nodes | **AcrPull** on the container registry |
| Your user | Deployment | **Key Vault Administrator** and cluster admin |

Workloads authenticate to Azure with these federated identities; no
client secrets are stored in the cluster.

## Configuration

Set these with `azd env set <NAME> <value>` before `azd up` or
`azd provision`.

### Services

| Variable | Default | Description |
| --- | --- | --- |
| `DEPLOY_AZURE_COSMOSDB` | `true` | Deploy Azure Cosmos DB |
| `AZURE_COSMOSDB_ACCOUNT_KIND` | `MongoDB` | Cosmos DB API. Scope requires `MongoDB`. |
| `DEPLOY_AZURE_MANAGED_REDIS` | `true` | Deploy Azure Managed Redis |
| `DEPLOY_AZURE_STORAGE_ACCOUNT` | `true` | Deploy the storage account for queues and blobs |
| `DEPLOY_AZURE_CONTAINER_REGISTRY` | `true` | Deploy Azure Container Registry for the Scope images |
| `DEPLOY_AZURE_SERVICE_OPERATOR` | `true` | Create the ASO identity and install ASO |
| `DEPLOY_OBSERVABILITY_TOOLS` | `true` | Deploy monitoring, dashboards, and alerts |
| `DEPLOY_AZURE_SERVICE_BUS` | `false` | Deploy Azure Service Bus |
| `DEPLOY_AZURE_OPENAI` | `false` | Deploy Azure OpenAI |
| `AZURE_OPENAI_LOCATION` | `AZURE_LOCATION` | Region for Azure OpenAI |
| `DEPLOY_FLUX` | `false` | Install Flux and publish infrastructure outputs for the [Flux path](/self-hosting/deploy-flux/) |

### Cluster

| Variable | Default | Description |
| --- | --- | --- |
| `AKS_NODE_POOL_VM_SIZE` | `Standard_D2as_v4` | VM size for the `system` pool |
| `AKS_APPS_NODE_POOL_VM_SIZE` | `Standard_D4as_v4` | VM size for the `apps` pool |
| `AKS_WORKER_NODE_POOL_VM_SIZE` | `Standard_D2as_v4` | VM size for the `workers` pool |
| `DEPLOY_WINDOWS_CLUSTER` | `false` | Add the `winwrk` Windows pool |
| `AKS_WINDOWS_NODE_POOL_VM_SIZE` | `Standard_D2as_v4` | VM size for the Windows pool |
| `AKS_NETWORK_POLICY` | `cilium` | `cilium` or `calico`. Windows nodes require `calico`. |
| `AKS_AVAILABILITY_ZONES` | `[1,2,3]` | Zones for every pool |

### Alerts

| Variable | Default | Description |
| --- | --- | --- |
| `ALERT_EMAIL_RECIPIENTS` | `[]` | Email addresses for alert notifications |
| `ALERT_WEBHOOK_URL` | empty | Webhook for alert notifications |

### Authentication

Sign-in is optional. To enable Microsoft Entra ID sign-in, create an API
and a Portal app registration, then pass their client IDs:

```bash
azd env set AUTH_API_CLIENT_ID <api-client-id>
azd env set AUTH_PORTAL_CLIENT_ID <portal-client-id>
```

Provisioning doesn't create or change app registrations. It derives the
authority (`https://login.microsoftonline.com/<tenant-id>` in the Azure
public cloud) and the API scope (`api://<api-client-id>/access_as_user`)
and exposes them as outputs for the chart. See
[Authentication](/self-hosting/configuration/#authentication).

## Cluster add-ons

The `postprovision` hook installs these Helm charts on the `system` pool:

| Add-on | Chart version | Purpose |
| --- | --- | --- |
| External Secrets Operator | 0.15.1 | Sync Key Vault secrets into Kubernetes |
| Azure Service Operator v2 | 2.17.0 | Manage queues, blob containers, and MongoDB collections from the chart |
| KEDA | 2.16.1 | Scale workers on queue length |
| cert-manager | 1.17.1 | Certificates for ASO webhooks and ingress TLS |
| Reloader | 2.2.8 | Restart pods when secrets change |

With `DEPLOY_FLUX=true`, the hook also installs the Flux Operator (0.43.0)
and a Flux 2.7 instance. Flux then manages the add-ons as `HelmRelease`
objects so later version bumps go through Git.

## Outputs

`azd` stores Bicep outputs in the environment. Read them with
`azd env get-values`. The chart needs these:

| Output | Chart value |
| --- | --- |
| `AZURE_TENANT_ID` | `azure.tenantId` |
| `AZURE_KEYVAULT_URI` | `azure.keyVault.uri` |
| `AZURE_IDENTITY_CLIENT_ID` | `azure.workloadIdentity.externalSecretsClientId` |
| `KV_SECRETS_OFFICER_IDENTITY_CLIENT_ID` | `azure.workloadIdentity.tokenManagerClientId` |
| `AZURE_STORAGE_ACCOUNT_NAME` | `azure.storage.accountName` |
| `AZURE_STORAGE_ACCOUNT_ARM_ID` | `azure.storage.accountArmId` |
| `AZURE_COSMOSDB_ACCOUNT_ARM_ID` | `azure.cosmosDb.accountArmId` |
| `AZURE_CONTAINER_REGISTRY_ENDPOINT` | `image.registry` |
| `AUTH_AUTHORITY`, `AUTH_API_CLIENT_ID` | `auth.entra.authority`, `auth.entra.apiClientId` |

Connection strings and keys are never outputs. They go straight to Key
Vault; see [Secrets](/self-hosting/configuration/#secrets).

## Region-specific overrides

Not every region supports three availability zones. If provisioning fails
with `AvailabilityZoneNotSupported`, set the zones your region offers:

```bash
azd env set AKS_AVAILABILITY_ZONES '[2]'
```

## Tear down

```bash
azd down --force --purge
```

This deletes the resource group and **purges** the soft-deleted Key
Vault, so its secrets can't be recovered. Export anything you need first.
