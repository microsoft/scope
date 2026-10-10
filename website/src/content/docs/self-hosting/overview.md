---
title: Self-hosting overview
description: Run your own Scope deployment on Kubernetes, provisioned on Azure Kubernetes Service with azd and Bicep.
---

Scope ships as a set of container images, a **Helm chart** that deploys
them to Kubernetes, and **Azure infrastructure as code** that provisions
an Azure Kubernetes Service (AKS) cluster with its managed backing
services. Use this section to run a shared, long-lived Scope deployment
for your team.

If you only want to try Scope or change its code, use
[Local development](/getting-started/local-development/) instead. It runs
the whole stack with Docker Compose and needs no Azure subscription.

## Where things live

| Path | Contents |
| --- | --- |
| [deploy/helm/scope](https://github.com/microsoft/scope/tree/main/deploy/helm/scope) | Helm chart for the Scope workloads |
| [infra/aks](https://github.com/microsoft/scope/tree/main/infra/aks) | Azure Developer CLI (`azd`) project, Bicep modules, and provisioning hooks for AKS |

## Choose a path

1. **Provision infrastructure.** On Azure, follow
   [Provision AKS](/self-hosting/provision-aks/). It creates the cluster,
   the backing services, and the workload identities, and installs the
   cluster add-ons Scope depends on. On another cluster, provide the
   equivalents yourself (see [Prerequisites](#prerequisites)).
2. **Deploy Scope.** Pick one of two paths. Both use the same chart and
   the same values:
   - [Deploy with Helm](/self-hosting/deploy-helm/): run
     `helm install` and `helm upgrade` yourself or from a CI pipeline.
   - [Deploy with Flux](/self-hosting/deploy-flux/): declare a Flux
     `HelmRelease` in Git and let the cluster reconcile it.
3. **Configure and operate.** Tune the chart with the
   [Configuration](/self-hosting/configuration/) reference, and use
   [Operations](/self-hosting/operations/) for upgrades, scaling, secret
   rotation, and troubleshooting.

| | Helm | Flux |
| --- | --- | --- |
| Who applies changes | You or your CI pipeline | Flux controllers in the cluster |
| Source of truth | Your values file and the chart revision you install | A `HelmRelease` committed to Git |
| Drift correction | None; rerun `helm upgrade` | Automatic on every reconcile |
| Extra cluster components | None | Flux controllers |
| Good fit | Single environment, quick setup, existing CD tooling | Several environments, promotion through Git |

## Architecture

```text
┌──────────────────────────── AKS cluster ────────────────────────────┐
│  Cluster add-ons:  External Secrets · Azure Service Operator ·      │
│                    KEDA · cert-manager · Reloader  (· Flux)         │
│                                                                     │
│  scoped namespace (Helm release)                                    │
│   portal ─► api ─► scheduler ──enqueue──┐                           │
│              │      judge   gateway     ▼                           │
│              │      token-manager    coder workers (KEDA, 0→N)      │
│              │                       post-processor, report-gen     │
└──────────────┼──────────────────────────┼───────────────────────────┘
               ▼                          ▼          private endpoints
   Cosmos DB (MongoDB API) · Azure Managed Redis · Storage (queues, blobs)
   Key Vault ◄── External Secrets, token-manager · Container registry
```

- **External Secrets Operator** copies connection strings and keys from
  Azure Key Vault into Kubernetes Secrets, using workload identity.
- **Azure Service Operator** creates the per-worker storage queues, the
  blob containers, and the MongoDB database and collections declared by
  the chart.
- **KEDA** scales each worker from zero, one replica per queued message.
- **Reloader** restarts pods when a synced secret changes.

### Workloads

The chart deploys these components into one namespace (`scoped` by
default):

| Component | Kind | Role |
| --- | --- | --- |
| `portal` | Deployment + Service | Web UI |
| `api` | Deployment + Service | REST API, log streaming, orchestration |
| `scheduler` | Deployment | Dispatches queued requests to worker queues |
| `judge` | Deployment + Service | Scores run output against the criteria DAG |
| `token-manager` | Deployment + Service | Stores and distributes agent tokens |
| `gateway` | Deployment + Service | AI gateway between workers and model providers |
| `coder-acp-copilot` | Deployment + KEDA `ScaledObject` | GitHub Copilot worker |
| `coder-acp-claude-code` | Deployment + KEDA `ScaledObject` | Claude Code worker |
| `coder-acp-copilot-windows` | Deployment + KEDA `ScaledObject` | GitHub Copilot worker on Windows (optional) |
| `post-processor`, `report-generator` | Deployment + KEDA `ScaledObject` | Post-run processing and reports |
| `model-scanner-copilot`, `model-scanner-anthropic` | CronJob | Detect available models |
| `db-migration` | Job (Helm hook) | Applies database migrations before the API starts |
| Agent version registration | Jobs (Helm hooks) | Register each worker's agent version with the API |

See [Coding agents & capabilities](/reference/workers/) for what each
worker runs.

## Prerequisites

[Provision AKS](/self-hosting/provision-aks/) provides everything below.
If you bring your own cluster, you need:

| Requirement | Used for |
| --- | --- |
| Kubernetes cluster with Linux nodes (and Windows nodes for the Windows worker) | Running the workloads |
| [Helm](https://helm.sh/) 3 | Installing the chart |
| [KEDA](https://keda.sh/) | Scaling workers on queue length |
| [External Secrets Operator](https://external-secrets.io/) | Syncing secrets from Azure Key Vault, unless you create the Kubernetes Secrets yourself |
| [Azure Service Operator v2](https://azure.github.io/azure-service-operator/) | Creating storage queues, blob containers, and MongoDB collections, unless you create them yourself |
| [Reloader](https://github.com/stakater/Reloader) | Restarting pods when secrets change (recommended) |
| MongoDB-compatible database | Scope data; Azure Cosmos DB for MongoDB on AKS |
| Redis | Caching and real-time log fan-out |
| Azure Storage account (queues and blobs) | Worker queues and run artifacts |
| Container registry | Hosting the Scope images |

Coding workers also need credentials for the agents they run: a token
from an account with an active GitHub Copilot entitlement for the Copilot
workers, and an Anthropic API key for Claude Code.
