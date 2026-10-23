---
title: Autoscaling with KEDA
description: How Scope scales queue-driven AI coding-agent workers and Kubernetes node pools.
---

Scope's production/reference architecture uses two coordinated Kubernetes
scaling layers. [KEDA](https://keda.sh/) scales queue-consuming AI
coding-agent worker pods, while the Kubernetes cluster autoscaler supplies
the node-pool capacity those pods need.

An **AI coding-agent worker** is the Kubernetes workload that launches a
coding agent such as GitHub Copilot or Claude Code to execute a Scope run.
Other queue consumers, including post-run processors, can use the same KEDA
scaling pattern.

## Scaling flow

The Scope scheduler dispatches each run to the Azure Storage Queue assigned
to its AI coding-agent worker type. The
[KEDA Azure Storage Queue scaler](https://keda.sh/docs/latest/scalers/azure-storage-queue/)
watches that queue and changes the corresponding AI coding-agent worker
Deployment's replica count. Kubernetes then schedules the requested pods
onto a compatible worker node pool. Only after a pod is running on a node can
it dequeue and process runs.

```mermaid
flowchart TD
    Scheduler[Scope scheduler]

    subgraph Demand["Event-driven pod scaling"]
        Queue[(Azure Storage Queue)]
        KEDA[KEDA ScaledObject]
        Deployment[AI agent worker Deployment]

        Queue -->|queue depth| KEDA
        KEDA -->|sets replicas| Deployment
    end

    subgraph Capacity["Kubernetes scheduling and capacity"]
        Requested[Requested AI agent worker pods]
        KubeScheduler[Kubernetes scheduler]
        Autoscaler[Cluster autoscaler]
        Pool[AI agent worker node pool]
        Running[Running AI agent worker pods]

        Requested --> KubeScheduler
        KubeScheduler -->|places pods when capacity is available| Pool
        KubeScheduler -.->|pods remain pending without capacity| Autoscaler
        Autoscaler -->|adds or removes nodes| Pool
        Pool -->|hosts| Running
    end

    Scheduler -->|dispatches run| Queue
    Deployment --> Requested
    Running -->|dequeues and processes runs| Queue

    classDef scope fill:#514bc5,stroke:#b1b4ff,color:#fff,stroke-width:2px
    classDef queue fill:#36318a,stroke:#7778ee,color:#fff,stroke-width:2px
    classDef scaler fill:#514bc5,stroke:#b1b4ff,color:#fff
    classDef deployment fill:#202453,stroke:#7778ee,color:#fff
    classDef pending fill:#576079,stroke:#a7afc5,color:#fff
    classDef kubernetes fill:#303749,stroke:#a7afc5,color:#fff
    classDef running fill:#16754c,stroke:#83dcb0,color:#fff,stroke-width:2px

    class Scheduler scope
    class Queue queue
    class KEDA,Autoscaler scaler
    class Deployment deployment
    class Requested pending
    class KubeScheduler,Pool kubernetes
    class Running running

    style Demand fill:transparent,stroke:#7778ee,stroke-width:2px
    style Capacity fill:transparent,stroke:#576079,stroke-width:2px
```

## Scale AI coding-agent worker pods with KEDA

Each queue-driven AI coding-agent worker has a KEDA
[`ScaledObject`](https://keda.sh/docs/latest/reference/scaledobject-spec/)
associated with its Azure Storage Queue. As queued work arrives, KEDA
increases the worker Deployment's desired replica count within that worker's
configured limits. Each pod launches the selected coding agent and processes
runs for its worker type.

When the queue drains and the cooldown period expires, KEDA reduces the
replica count. Queue consumers can
[scale to zero](https://keda.sh/docs/latest/concepts/scaling-deployments/)
when they are idle, avoiding AI coding-agent compute cost when Scope has no
runs for them.

Polling intervals, cooldowns, and replica limits are deployment settings.
They can differ by worker because AI coding agents and post-run processors
have different resource and concurrency requirements.

## Scale AI coding-agent worker node pools

KEDA does not scale node pools directly. It creates demand by increasing the
number of worker pods. The Kubernetes scheduler first tries to place those
pods on compatible nodes.

If pods remain pending because an AI coding-agent worker node pool lacks
capacity, the cluster autoscaler can add nodes to that pool. When KEDA later
removes idle agent worker pods and nodes become unneeded, the cluster
autoscaler can remove the excess nodes.

Node selectors, taints, tolerations, operating-system requirements, and
resource requests determine which node pool can host each AI coding-agent
worker. Configure those scheduling constraints and the cluster autoscaler's
minimum and maximum node counts together so every AI coding-agent worker has
an eligible pool.

## Current self-hosting quickstart

The public [Helm chart](https://helm.sh/docs/topics/charts/) and Azure
quickstart documented here do not install KEDA or configure cluster
autoscaling yet. They use fixed Deployment replica counts and fixed AKS node
counts.

Use [Operations](/self-hosting/operations/#scale) to change application
replicas and [Node pools](/self-hosting/provision-aks/#node-pools) to change
the currently shipped AKS pool sizes.
