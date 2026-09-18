# Scope Documentation

Central documentation hub for the Scope platform — an AI coding agent benchmarking system.

## Architecture & Design

| Document | Description |
|----------|-------------|
| [System Overview](architecture/overview.md) | High-level architecture, component interactions, data flow |
| [Architecture Layers](architecture/architecture-layers.md) | 5-layer responsibility model — from cloud foundation to app workloads |
| [Application Design](architecture/app-design.md) | Data models, API design, judge pipeline, queue patterns, criteria system |
| [VS Code Web Worker](architecture/vscode-web-worker.md) | XState chat machine, GitHub auth flow, ARIA snapshots, AI dev loop |
| [Token Manager](architecture/token-manager.md) | Capability-based token management, validation, round-robin distribution |
| [Authentication & RBAC](architecture/auth-rbac.md) | Explicit-login IdP authentication, Redis user-access caching, Portal handshake; deferred RBAC roadmap |
| [Worker Requirements](architecture/worker-requirements.md) | Requirements checklist for coding agent workers |
| [Worker Compliance](architecture/worker-compliance.md) | Per-worker compliance matrix against requirements |
| [Database Migrations](architecture/db-migrations.md) | Lightweight MongoDB migration framework, writing and running migrations |
| [Database Collection Scaling](architecture/db-collection-scaling.md) | Per-collection autoscale throughput, ASO reconcile policy, operator runbook |
| [GitOps & Deployment](architecture/gitops-deploy.md) | FluxCD design, kustomization phases, variable substitution |

## Infrastructure

| Document | Description |
|----------|-------------|
| [AKS Node Pool Separation](infrastructure/aks-node-pool-separation.md) | Taints, tolerations, node selectors for workload isolation |
| [Azure Developer CLI](infrastructure/azd-deployment.md) | Provisioning with `azd up`, feature flags, environment variables |

## Responsible AI

| Document | Description |
|----------|-------------|
| [Responsible AI FAQ](responsible-ai-faq.md) | Intended uses, limitations, AI capabilities, risks and mitigations for the OneRAI transparency documentation |

## Operations

| Document | Description |
|----------|-------------|
| [Cosmos DB Backup & Restore](ops/cosmos-backup-restore.md) | `pnpm db:dump` / `pnpm db:restore` rollback tooling, presets, verification, Cosmos caveats |

## Research

| Document | Description |
|----------|-------------|
| [Delta Storage](research/delta-storage.md) | Approaches for space-efficient storage of coding agent iteration snapshots |

## Tips & Tricks

| Document | Description |
|----------|-------------|
| [Developer Tips & Tricks](tips/README.md) | Short, practical tips for working productively in this repo (one file per tip) |

## Decisions

Architecture Decision Records (ADRs) capture significant design choices and their rationale.

| Document | Description |
|----------|-------------|
| [ADR Template](decisions/000-template.md) | Template for new ADRs |

---

## Where else is documentation?

- **Sub-project READMEs** — Quick-start and setup guides:
  - [`scope-mt-app/README.md`](../scope-mt-app/README.md) — Application setup, Docker Compose, features
  - [`scope-mt-infra/README.md`](../scope-mt-infra/README.md) — Azure infrastructure overview
- **[`scope-mt-app/ENV_VARIABLES.md`](../scope-mt-app/ENV_VARIABLES.md)** — Environment variable reference for the criteria/judge system
- **[`scope-mt-app/config/`](../scope-mt-app/config/)** — Domain knowledge encoded as YAML (scenarios, personas, criteria, traits)
- **[`.github/copilot-instructions.md`](../.github/copilot-instructions.md)** — Development conventions and patterns for AI assistants
