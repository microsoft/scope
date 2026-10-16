# Deploy Scope to Azure

This folder contains a sanitized, resource-group-scoped Bicep template that provisions
the Azure infrastructure needed to run Scope. It powers the **Deploy to Azure** button
below and is also usable standalone via the Azure CLI.

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fmicrosoft%2Fscope%2Fmain%2Fdeploy%2Fazure%2Fazuredeploy.json)

> This is a separate, from-scratch template built for open-source consumers. It is
> unrelated to the `infra/` folder and root `azure.yaml` at the repository root, which
> drive an internal `azd`-based developer CosmosDB setup and are not part of this
> package.

## Good to know before you deploy

- **Smooth sailing most of the time, with the occasional retry.** This template is
  tuned to deploy cleanly on typical free/dev subscriptions, but a couple of the
  managed services it provisions (AKS node availability zones, Cosmos DB zonal
  capacity, Azure Managed Redis allocation) sit on shared regional capacity that
  Azure allocates on demand. If a deployment reports a capacity or quota error,
  it's almost always transient — re-running the same deployment, or picking a
  different region, resolves it. See [Sizing and
  quota](#sizing-and-quota-this-is-a-minimal-dev-footprint) below for the specifics
  and workarounds we've already tuned in.
- **Built to be lean, so it's easy to try and easy to tidy up.** Every resource here
  defaults to the smallest practical SKU to keep this an inexpensive way to kick the
  tires. Once you're done exploring, deleting the resource group removes everything
  in one step and stops billing immediately — a nice habit to get into for any
  sandbox deployment like this one.

## What this deploys

- **Networking**: a VNet with a dedicated AKS node subnet and a private-endpoints
  subnet, each with a network security group.
- **AKS cluster**: one System node pool and one User node pool (Linux only), Azure CNI
  Overlay with the Cilium network dataplane/policy, an OIDC issuer, Workload Identity,
  and the native **Azure Key Vault Secrets Provider** add-on enabled (this is how
  secrets get into the cluster — via a Helm install, not GitOps/Flux). Defaults to
  `Standard_D2s_v5` nodes (2 vCPU / 8 GB, general-purpose) and no availability-zone
  placement, with 1 System node + 2 User nodes, to minimize regional vCPU-quota
  pressure, maximize regional/SKU compatibility, and leave CPU headroom for an
  optional ACP worker pod — see
  [Sizing and quota](#sizing-and-quota-this-is-a-minimal-dev-footprint) below.
- **Key Vault**: RBAC-authorized, private endpoint only, with the backend workload
  identity (not the worker identity — see below) granted `Key Vault Secrets Officer`
  access (read/write/delete on secrets, not just read) — the app's Token Manager
  service writes BYO credentials into the vault at runtime via this same identity,
  so read-only access isn't sufficient.
- **Azure Container Registry**: `Basic` SKU by default (sufficient for a single small
  worker image), admin user disabled; the AKS kubelet identity is granted `AcrPull`
  so nodes can pull the worker image (which cannot be hosted on GHCR for private
  use).
- **Cosmos DB**: MongoDB API only, private endpoint only, serverless throughput.
- **Azure Managed Redis**: private endpoint only, `Balanced_B0` SKU (the smallest
  available) with high availability **disabled** by default, with Microsoft Entra ID
  (Azure AD) authentication enabled; an access key is also provisioned as a
  compatibility fallback for clients that don't yet support Entra ID auth. See
  [Sizing and quota](#sizing-and-quota-this-is-a-minimal-dev-footprint) below for why.
- **Storage account**: blob and queue services only, private endpoints only, with
  **both** workload identities (backend and worker — see below) granted
  `Storage Blob Data Owner` (not just Contributor — the app sets Blob Index Tags on
  snapshot uploads, which Contributor's data actions don't permit) and
  `Storage Queue Data Contributor`.
- **Two user-assigned managed identities**, each federated with the AKS OIDC issuer
  for use as Kubernetes workload identities:
  - A **backend identity** (`scope-workload-identity` by default) for trusted
    components (api, Token Manager, scheduler, etc.) — granted Key Vault,
    Redis, and Storage data-plane access.
  - A **worker identity** (`scope-worker-workload-identity` by default) for ACP
    worker pods only — granted **Storage data-plane access only**. ACP workers
    execute benchmark-controlled/untrusted agent code, so this identity
    deliberately has **no Key Vault role** and is never wired into the Key Vault
    module: a compromised worker process cannot read or write secrets. Worker
    pods get their BYO credentials (GitHub/Anthropic keys) via a plain
    Kubernetes Secret populated from the backend identity's CSI-mounted
    secrets, so they never need to call Key Vault directly.

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

## Sizing and quota (this is a minimal dev footprint)

The defaults in this template deliberately trade away performance and high
availability for a smaller footprint that is much more likely to deploy
successfully on a new, free, or otherwise quota-constrained Azure subscription:

- **AKS node pools** default to `Standard_D2s_v5` nodes (System: 1 node, User: 2
  nodes — 3 nodes / 6 vCPUs total) with no availability-zone placement
  (`availabilityZones: []` on both pools), rather than multi-node, zone-redundant
  pools. Many new/free subscriptions start with a **10 vCPU total regional quota**,
  so keeping the total footprint small matters more than which VM family it comes
  from — a 5-node `Standard_D4s_v5` footprint (20 vCPUs) can exceed that limit
  before you even get to the app. `Standard_D2s_v5` was chosen over a burstable
  `B`-series size because SKU availability varies a lot by subscription (e.g. some
  subscriptions only allow the newer `_v2` B-series, not classic sizes like
  `Standard_B2ms`) and some regions don't support AKS availability zones at all —
  `Dsv5` and zone-less placement are broadly available across subscriptions/regions.
  The User pool defaults to **2 nodes (not 1)**: the core app alone (api/portal/judge/
  token-manager/scheduler/report-generator) already consumes roughly 85% of a single
  node's allocatable CPU, leaving no room to schedule an optional Phase 3 ACP worker
  pod (`coder-acp-copilot`: 500m main + 250m MCP-gateway sidecar = 750m) — confirmed
  live via `Insufficient cpu` scheduling failures with a single user node. If you're
  only running the core app (no ACP workers), `aksUserNodeCount=1` is sufficient.
  This is still a non-HA configuration for the System pool — raise
  `aksSystemNodeCount`/`aksUserNodeCount` further, set explicit `availabilityZones`
  in `modules/aks.bicep`, and consider a larger VM family (e.g. `Standard_D4s_v5`)
  for a production environment.
- **Cosmos DB** defaults to a single, non-zone-redundant region
  (`isZoneRedundant: false` in `modules/cosmosdb.bicep`), rather than the AVM
  module's implicit zone-redundant fallback. Some regions (e.g. `centralus`)
  intermittently run out of zonal capacity for Cosmos DB and fail deployment
  with `ServiceUnavailable`/"high demand ... for the zonal redundant
  (Availability Zones) accounts" — this is independent of subscription quota
  and can happen even when it didn't on a previous deploy. Add zone redundancy
  (and a multi-region `locations` array) back for a production environment.
- **Azure Managed Redis** defaults to the smallest SKU (`Balanced_B0`) with
  **high availability disabled** (`redisHighAvailability=Disabled`). Azure Managed
  Redis allocation can fail with `InsufficientCapacity` — or, less commonly, with
  a generic transient `ComputeProvisioningFailed` infrastructure error — in a
  given region independent of your subscription's vCPU quota. This is a known
  constraint on this still-rolling-out SKU family, and it gets worse with larger
  SKUs and with HA enabled (which roughly doubles the underlying node
  allocation); it is **not** related to availability zones — zone placement
  only applies to the Enterprise/EnterpriseFlash SKU tiers, not the
  `Balanced`/AMR tier used here. If you hit either error with these defaults,
  wait a few minutes and retry, or try a different region, before filing a
  support request. Enable HA (and size up) for production.
- **Azure Container Registry** defaults to `Basic` (down from `Standard`) — plenty
  for a single worker image and consumes no compute quota, just lower
  storage/throughput ceilings.

If you still hit a quota error after these defaults, the fastest fixes are
(1) request a quota increase for the affected VM family/region at
[aka.ms/myquotas](https://portal.azure.com/#view/Microsoft_Azure_Capacity/QuotaMenuBlade/~/myQuotas),
or (2) deploy to a different, less-contended region.

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
    ├── redis.bicep             # Azure Managed Redis (Redis Enterprise, Balanced tier)
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
- Redis is deployed as Azure Managed Redis (`Microsoft.Cache/redisEnterprise`,
  `Balanced_*` SKU tier) rather than classic Azure Cache for Redis — the classic
  service is being retired for new deployments. The default SKU is `Balanced_B0`
  with high availability disabled (see
  [Sizing and quota](#sizing-and-quota-this-is-a-minimal-dev-footprint) above); the
  workload identity is granted Entra ID data-plane access via an access policy
  assignment on the default database, with access-key auth left enabled as a
  compatibility fallback.
- Cosmos DB uses serverless throughput by default to minimize idle cost for a
  quickstart deployment; switch to provisioned RU/s if you need guaranteed
  throughput.
