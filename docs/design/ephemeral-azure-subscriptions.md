# Proposal: Ephemeral Azure Deploy Environments for Coding Agents

**Status:** Draft / for team review
**Author:** (SCOPE team)
**Date:** 2026-06-19

## Summary

Some SCOPE scenarios require the coding agent to actually **deploy** what it
builds (a web app, a function, a container, a database) to a real cloud. To do
that safely we need to hand each agent run an **isolated, disposable Azure
environment** that it can deploy into, and that we can reliably tear down when
the run finishes — including when the run crashes.

This document evaluates the options, recommends **per-run ephemeral resource
groups inside a single dedicated sandbox subscription**, and sketches how it
maps onto SCOPE's existing run/worker lifecycle.

It also defines a provider-agnostic **`EphemeralEnvironment` abstraction** — the
general notion of *something that must be provisioned before a run and torn down
after it*. That isn't limited to clouds: it could be an Azure resource group, but
equally a database, a PaaS app, or any other disposable resource. Azure resource
groups are simply the first implementation; other kinds plug in behind the same
interface.

## Goals

- Give each agent run clean, disposable environment(s) to use during the run.
- **Generic ephemeral-environment abstraction** — the run/worker lifecycle
  depends on an `EphemeralEnvironment` interface (provision before / tear down
  after), not on any specific resource type or cloud. An environment can be an
  Azure resource group, a database, a PaaS app, etc. (Azure resource groups are
  the only implementation delivered here.)
- **Functional isolation** between concurrent runs (a run cannot see or touch
  another run's resources).
- **Guaranteed teardown** — one operation nukes everything a run created, plus a
  safety-net sweep for orphans from crashed runs.
- **Cost attribution** per run / scenario / agent.
- **Guardrails** — bound the blast radius (allowed regions, SKUs, spend) so an
  agent can't accidentally (or via a hostile prompt) provision something huge.

## Non-goals

- A hard security boundary against **untrusted/hostile** agent code. The team
  decided functional isolation at the resource-group level is sufficient for
  now. If that changes, see [Alternative B](#alternative-b--subscription-pool).
- Multi-cloud. This proposal is Azure-only.

## Requirements

### Functional

- **On-demand provisioning** — each agent run can be given a dedicated, empty
  Azure environment to deploy into at run start.
- **Isolation (including non-visibility)** — the agent can only see and modify
  resources in its own environment. It must **not even be able to enumerate or
  see** other runs' resource groups or resources — listing returns only its own
  environment. Achieved by scoping the run's credential to just its RG (an
  RG-scoped role cannot list resources outside that scope).
- **Credential delivery** — the run receives a credential scoped to its own
  environment so the agent can deploy into it. **How** that credential is
  delivered to the agent is an open question (see Open questions).
- **Guaranteed teardown** — everything a run created can be destroyed by a
  single, reliable operation at run end.
- **Orphan cleanup** — environments left behind by crashed or abandoned runs are
  automatically reclaimed without manual intervention.
- **Cost attribution** — spend can be attributed per run, scenario, and agent.
- **Opt-in** — only scenarios that declare a need for a deploy environment
  receive one; other scenarios are unaffected.

### Non-functional

- **Guardrails** — allowed regions, resource types/SKUs, and spend are bounded so
  a run cannot provision outside an approved envelope.
- **Low latency** — provisioning adds negligible time to run startup.
- **Concurrency** — supports the target number of simultaneous deploying runs
  without collisions or quota exhaustion (target TBD — see Open questions).
- **Least privilege** — the control-plane identity and per-run credentials hold
  the minimum rights required, scoped to the sandbox subscription / RG.
- **Auditability** — provision and teardown events are logged and traceable to a
  run.
- **Self-cleaning by default** — the system trends toward an empty sandbox; no
  run can leave indefinitely-billed resources behind.

## Background: Azure's hierarchy (why not "sub-subscriptions")

Azure has **no concept of nesting one subscription under another.** The
hierarchy is:

```
Management Group   (can be nested, up to ~6 levels — this is the real "parent of subscriptions")
 └─ Subscription   (flat — subscriptions are peers, never parent/child)
     └─ Resource Group
         └─ Resource
```

So the unit of grouping *under* a subscription is the **resource group**, and
the unit of grouping *over* subscriptions is the **management group**. There is
no "child subscription."

A dedicated sandbox subscription already exists for this purpose:

| Name | State |
|------|-------|
| `SCOPE-deploy` | Enabled |

## Options considered

### Option 1 — Ephemeral resource groups (recommended)

One shared sandbox subscription; each run gets a fresh resource group
(`rg-scope-<runId>`) and a credential scoped `Contributor` to **only** that RG.

- **Isolation:** RBAC-scoped — the run's identity can't enumerate or touch other
  RGs. Functional isolation, not a hostile-code security boundary.
- **Teardown:** `az group delete` deletes the RG and everything in it in one
  call. Maps perfectly to "ephemeral."
- **Speed:** instant — no provisioning latency.
- **Cost:** tag each RG; cost reports group by tag.
- **Limits:** runs share the subscription's quotas and policy boundary; a few
  resource kinds are subscription-scoped. Fine for typical "deploy an app"
  scenarios.

### Alternative A — Per-run ephemeral subscriptions

Create a subscription per run via the **Subscription Alias API**
(`Microsoft.Subscription/aliases` / `az account alias create`) under an EA / MCA
/ MPA billing account.

- **Isolation:** full subscription boundary (separate quota, policy, billing).
- **Dealbreaker for "ephemeral":** subscriptions **cannot be hard-deleted on
  demand.** Cancelling moves them to a *Disabled* state and they are purged
  after ~90 days. You also hit caps on subscriptions per billing account and
  non-trivial creation latency. Not recyclable per-run.

### Alternative B — Subscription pool

Pre-create N subscriptions under a management group, lease one per run, wipe all
its resource groups on return.

```
Management Group: scope-agents
 ├─ sub-pool-01  (leased → run A)
 ├─ sub-pool-02  (leased → run B)
 └─ sub-pool-03  (free)
```

- Gives a real subscription boundary without per-run creation latency or the
  90-day disposal problem.
- More moving parts (lease manager, reset/wipe logic, pool sizing).
- **Use this only if** scenarios need subscription-scoped isolation that RGs
  can't provide, or if agent code becomes untrusted.

### Decision

Adopt **Option 1**. Keep Alternative B documented as the upgrade path if the
isolation requirement hardens.

## Ephemeral environment abstraction

The core notion is an **ephemeral environment**: anything a run needs that must be
**provisioned before the run and torn down after it completes**. This is *not*
inherently a cloud concept — it could be an Azure resource group, but equally a
PaaS app, a database instance, a namespace, a sandbox account, or any other
provisionable, disposable resource. The run/worker lifecycle depends only on this
abstraction; concrete kinds (starting with Azure resource groups) implement it.

### Core interface

```ts
/** A provisioned, disposable environment leased to a single run.
 *  Not cloud-specific — could be a resource group, a database, a PaaS app, etc. */
interface EphemeralEnvironment {
  /** Stable id for this lease (e.g. the runId). */
  id: string;
  /** What kind of environment this is, e.g. "azure-resource-group",
   *  "postgres-database", "paas-app". */
  kind: string;
  /** Opaque, kind-specific handles (e.g. Azure RG: { subscriptionId, resourceGroup };
   *  database: { host, dbName }). */
  handles: Record<string, string>;
  /** How the agent authenticates/connects into this environment
   *  (see Credential delivery). */
  credential: EnvironmentCredential;
  /** Tags/labels applied for cost attribution and orphan cleanup. */
  tags: Record<string, string>;
  /** When this lease should be reclaimed if not torn down sooner. */
  expiresAt: Date;
}

/** Provisions and reclaims ephemeral environments of one kind. */
interface EphemeralEnvironmentProvider {
  /** The kind of environment this provider manages. */
  readonly kind: string;
  /** Create an isolated, empty environment for a run. */
  provision(req: ProvisionRequest): Promise<EphemeralEnvironment>;
  /** Destroy everything created in the environment. Idempotent. */
  teardown(env: EphemeralEnvironment): Promise<void>;
  /** Reclaim expired/orphaned environments (the janitor calls this). */
  reclaimExpired(now: Date): Promise<{ reclaimed: string[] }>;
}

interface ProvisionRequest {
  runId: string;
  scenario: string;
  agent: string;
  ttl: string;               // e.g. "2h"
  tags?: Record<string, string>;
  /** Kind-specific options (e.g. region/SKU for Azure). */
  options?: Record<string, unknown>;
}
```

A run may need **more than one** ephemeral environment (e.g. an Azure RG *and* a
database); the orchestrator provisions each via its provider and tears all of
them down at run end.

`EnvironmentCredential` is deliberately open (its concrete shape and delivery
mechanism are an [open question](#open-questions)) — e.g. a pre-authenticated CLI
context, env vars, a mounted file, a connection string, or a federated identity.

### First implementation: Azure resource group

This document specifies the **`azure-resource-group`** provider. The sandbox
boundary is the `SCOPE-deploy` subscription, the per-run environment is a resource
group, teardown is `az group delete`, and orphan cleanup is a TTL tag sweep.
Other kinds (databases, PaaS apps, non-Azure clouds) implement the same interface
and are out of scope here.

Workers depend only on `EphemeralEnvironmentProvider`; concrete providers are
selected by config / scenario need.

## Recommended design (Option 1 — `azure-resource-group` provider)



### One-time setup (sandbox subscription `SCOPE-deploy`)

1. Place `SCOPE-deploy` under a management group with **Azure Policy**
   guardrails:
   - allowed regions (e.g. `eastus2` only)
   - allowed resource types / denied expensive SKUs
   - deny or constrain public networking where not needed
2. Create a **Budget** with alerts and an action group (optional: auto-disable
   on overspend).
3. Create a **control-plane identity** (the orchestrator's identity) with rights
   to create resource groups and role assignments **in this subscription only**.
   In AKS this should be a **workload identity / managed identity**, consistent
   with the existing External Secrets / token-manager identity setup
   (`deploy/base/secret-store.yaml`, `deploy/base/token-manager.yaml`).

### Per-run lifecycle

Mapped onto the existing `WorkerProcessor` hooks
(`packages/shared/src/types/types.ts`):

| Phase | Hook | Action |
|-------|------|--------|
| Provision | `setup()` | `provider.provision({ runId, scenario, agent, ttl })` → Azure provider creates `rg-scope-<runId>`, mints an RG-scoped credential, returns an `EphemeralEnvironment`. |
| Run | `processMessage()` | Agent deploys into its environment using the returned credential. |
| Teardown | `teardown()` | `provider.teardown(env)` → deletes the RG (`--no-wait`) and the per-run credential. Always runs if `setup()` ran, even on error. |

The hooks call the provider interface, not Azure directly. The Azure provider
implements `provision`/`teardown` as below.

Provision:

```bash
RG="rg-scope-${RUN_ID}"
SUB="<SCOPE-deploy subscription id>"

az group create -n "$RG" -l eastus2 --subscription "$SUB" \
  --tags run-id=$RUN_ID scenario=$SCENARIO agent=$AGENT \
         ttl=2h created=$(date -u +%FT%TZ)

# Short-lived SP scoped to ONLY this RG (or prefer a federated/managed identity)
az ad sp create-for-rbac --name "sp-scope-${RUN_ID}" \
  --role Contributor \
  --scopes "/subscriptions/${SUB}/resourceGroups/${RG}"
```

Teardown:

```bash
az group delete -n "rg-scope-${RUN_ID}" --subscription "$SUB" --yes --no-wait
az ad sp delete --id "$SP_APP_ID"
```

### Orphan janitor (safety net)

A scheduled job (CronJob / scheduler task) deletes any RG in `SCOPE-deploy`
whose `ttl`/`created` tag is expired, catching runs that crashed before
`teardown()`. This is the backstop that keeps the sandbox clean and cheap.

```mermaid
flowchart LR
    Run["Agent run (worker)"] -->|setup()| RG["rg-scope-<runId>"]
    Run -->|teardown()| Del["az group delete"]
    Janitor["TTL janitor (cron)"] -->|sweep expired tags| Del
    Pol["Azure Policy + Budget"] -.guardrails.-> RG
```

### Credential delivery

**Open question — not yet decided.** The run needs a credential scoped to its
own RG, but *how* that credential is delivered to the coding agent is undecided
and likely varies per agent runtime. Candidate mechanisms:

- **Pre-authenticated `az` CLI** — the agent's environment ships with `az`
  already logged in and the default subscription set, so the agent just runs
  `az ...` (and tools that honor `AZURE_*` / the CLI token cache) with no
  credential handling of its own. Likely the lowest-friction option for agents.
- environment variables sourced from the workload identity / secret store (how
  other worker secrets reach workers today),
- a mounted credential/config file the agent's tooling picks up,
- a federated credential / managed identity the agent assumes directly.

Where the agent runtime supports it, prefer **federated credentials / managed
identity** over long-lived SP secrets to avoid handing out standing secrets.
Resolving this is tracked in [Open questions](#open-questions).

## Why this fits SCOPE

- RG lifecycle maps 1:1 onto the run lifecycle and the existing
  `setup()`/`teardown()` worker hooks — no new orchestration primitive.
- `az group delete` is the guaranteed single-command teardown the ephemeral
  model needs.
- Per-RG scoping means a run literally cannot enumerate other runs' resources.
- Tags give per-run cost attribution and power the janitor.
- Reuses the established AKS workload-identity + secret-delivery pattern.

## Open questions

- **RG/quota namespacing:** confirm `SCOPE-deploy` is exclusively for this
  purpose so RG-name and quota collisions with other workloads can't happen.
- **Concurrency ceiling:** how many simultaneous runs must the subscription
  support? This drives subscription-level quota requests and whether we ever
  need Alternative B.
- **Credential delivery to the agent:** *how* is the per-run credential handed
  to the coding agent (env vars, mounted file, federated/managed identity)? Likely
  varies per agent runtime. And in what **form** — short-lived SP secret vs.
  federated/managed identity?
- **Default region(s) and SKU allow-list** for the policy guardrails.
- **TTL default** and janitor cadence.

## Next steps (if approved)

1. Apply guardrails (policy + budget + control identity) to `SCOPE-deploy`.
2. Implement provision/teardown as a small shared helper invoked from worker
   `setup()`/`teardown()` (opt-in per scenario via a scenario flag).
3. Add the TTL janitor as a scheduler task / CronJob.
4. Document the scenario opt-in and credential contract for scenario authors.
