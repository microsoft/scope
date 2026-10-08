# Deploy Scope to Azure

This folder contains a sanitized, resource-group-scoped Bicep template that provisions
the Azure infrastructure needed to run Scope. It powers the **Deploy to Azure** button
below and is also usable standalone via the Azure CLI.

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fmicrosoft%2Fscope%2Fmain%2Fdeploy%2Fazure%2Fazuredeploy.json)

> This is a separate, from-scratch template built for open-source consumers. It is
> unrelated to the `infra/` folder and root `azure.yaml` at the repository root, which
> drive an internal `azd`-based developer CosmosDB setup and are not part of this
> package.

## What this deploys

- **Networking**: a VNet with a dedicated AKS node subnet and a private-endpoints
  subnet, each with a network security group.
- **AKS cluster**: one System node pool and one User node pool (Linux only), Azure CNI
  Overlay with the Cilium network dataplane/policy, an OIDC issuer, Workload Identity,
  and the native **Azure Key Vault Secrets Provider** add-on enabled (this is how
  secrets get into the cluster — via a Helm install, not GitOps/Flux).
- **Key Vault**: RBAC-authorized, private endpoint only, with a generated workload
  identity granted `Key Vault Secrets User` access.
- **Azure Container Registry**: admin user disabled; the AKS kubelet identity is
  granted `AcrPull` so nodes can pull the worker image (which cannot be hosted on
  GHCR for private use).
- **Cosmos DB**: MongoDB API only, private endpoint only.
- **Azure Cache for Redis**: private endpoint only, with Microsoft Entra ID
  (Azure AD) authentication enabled; an access key is also provisioned as a
  compatibility fallback for clients that don't yet support Entra ID auth.
- **Storage account**: blob and queue services only, private endpoints only, with the
  workload identity granted `Storage Blob Data Contributor` and
  `Storage Queue Data Contributor`.
- A **user-assigned managed identity** federated with the AKS OIDC issuer, for use as
  the Kubernetes workload identity.

## What this does **NOT** automate

- **Installing Scope itself.** This template provisions infrastructure only. The
  Scope application (API, workers, Judge, Portal, Token Manager) is installed
  separately via Helm charts against the AKS cluster this template creates. See the
  main [documentation site](https://microsoft.github.io/scope/) for Helm install
  instructions.
- **Populating application secrets.** After deploying, you must add any
  application-specific secrets your Helm install needs (e.g. GitHub OAuth app
  credentials, model/API keys) to the Key Vault created by this template. Two
  secrets are pre-populated for you automatically: `cosmos-connection-string` and
  `redis-primary-key` — everything else is bring-your-own.
- **Observability.** No Log Analytics workspace, Grafana, or alerting is provisioned
  in this v1 — bring your own monitoring stack if you need one.
- **DNS, TLS/ingress, or a public domain** for the Portal/API — those are configured
  as part of the Helm install, not this template.

## Prerequisites

- An Azure subscription with permission to create resources and role assignments
  (`Owner` or `Contributor` + `User Access Administrator`) in the target resource
  group.
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) with the Bicep
  tooling (`az bicep install`), if deploying from the command line instead of the
  portal button.
- `kubectl` and `helm`, for the application install step that follows infrastructure
  provisioning.

## Deploy via the Azure CLI

```bash
az group create --name <resource-group-name> --location <region>

az deployment group create \
  --resource-group <resource-group-name> \
  --template-file deploy/azure/main.bicep \
  --parameters deploy/azure/main.parameters.json \
  --parameters environmentName=<your-environment-name> location=<region>
```

## Structure

```
deploy/azure/
├── main.bicep                 # Orchestrator — wires all modules together
├── main.parameters.json       # Default parameter values
├── azuredeploy.json           # Compiled ARM template (used by the Deploy to Azure button)
├── createUiDefinition.json    # Azure portal UI definition (Basics/Advanced flow)
├── metadata.json              # Template gallery metadata
└── modules/
    ├── networking.bicep       # VNet, subnets, NSGs
    ├── aks.bicep               # AKS cluster
    ├── keyvault.bicep          # Key Vault + private endpoint
    ├── cosmosdb.bicep          # Cosmos DB (MongoDB API)
    ├── redis.bicep             # Azure Cache for Redis
    ├── storage.bicep           # Storage account (blob + queue)
    └── acr.bicep               # Azure Container Registry
```

## Keeping `azuredeploy.json` in sync

`azuredeploy.json` is a compiled artifact of `main.bicep`, committed to the repo so the
Deploy to Azure button can reference a stable raw-GitHub URL (the portal's template
deployment blade cannot consume `.bicep` files directly). Whenever you change any file
under `deploy/azure/`, regenerate it:

```bash
az bicep build --file deploy/azure/main.bicep --outfile deploy/azure/azuredeploy.json
```

A CI check (`.github/workflows/deploy-azure-drift.yml`) rebuilds `main.bicep` and fails
the build if `azuredeploy.json` doesn't match — commit the regenerated file if it does.

## Assumptions and notes

- Resource names are derived from `environmentName` plus a deterministic
  `uniqueString()` suffix to satisfy Azure's global-uniqueness requirements (Key
  Vault, ACR, Storage, Cosmos DB, Redis) without requiring manual input.
- The AKS API server is left publicly reachable (not a private cluster) so a
  developer can run `az aks get-credentials` and `kubectl`/`helm` without a jumpbox or
  VPN — this is a public, open-source quickstart template, not a locked-down
  enterprise deployment. Only the data-plane services (Key Vault, Cosmos DB, Redis,
  Storage) sit behind private endpoints.
- AKS local accounts are left enabled (rather than requiring Entra ID cluster admin
  integration) so `az aks get-credentials` produces a working kubeconfig out of the
  box.
- Redis is deployed as classic Azure Cache for Redis rather than Azure Managed Redis
  (Redis Enterprise); the latter could be a future upgrade path.
- Cosmos DB uses serverless throughput by default to minimize idle cost for a
  quickstart deployment; switch to provisioned RU/s if you need guaranteed
  throughput.
