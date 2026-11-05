# Kubedock — Container Access for Workers

Kubedock gives coding agents the ability to run Docker commands (build, run, exec) during task execution. It translates Docker API calls into Kubernetes pod operations, so agents can use standard Docker workflows without requiring Docker-in-Docker or privileged containers.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Worker Pod                                                  │
│                                                              │
│  ┌──────────────────┐      ┌─────────────────────────────┐  │
│  │  Worker Container │      │  Kubedock Sidecar            │  │
│  │                   │      │  (joyrex2001/kubedock:0.17.0)│  │
│  │  Agent subprocess │      │                              │  │
│  │  ┌─────────────┐ │      │  Docker API → K8s Pods       │  │
│  │  │ docker run  │─┼──────┼─▶ unix socket                │  │
│  │  │ docker build│ │      │   /var/run/kubedock/          │  │
│  │  │ docker exec │ │      │   kubedock.sock               │  │
│  │  └─────────────┘ │      │                              │  │
│  └──────────────────┘      └──────────────┬──────────────┘  │
│                                           │                  │
└───────────────────────────────────────────┼──────────────────┘
                                            │
                                            ▼
                                   ┌────────────────┐
                                   │  Kubernetes API │
                                   │  (creates pods) │
                                   └────────────────┘
```

## How It Works

1. **Kubedock sidecar** starts and creates a Unix socket at `/var/run/kubedock/kubedock.sock`
2. **Worker container** sets `DOCKER_HOST=unix:///var/run/kubedock/kubedock.sock` in agent subprocess env
3. **Agent** runs standard Docker commands (`docker run`, `docker build`, etc.)
4. **Kubedock** intercepts those commands via the socket and translates them into Kubernetes pod operations in the same namespace
5. **`--port-forward`** flag enables localhost access to spawned containers from the worker pod

## Feature Flag (Kustomize Component)

The devcontainer's [Kind mode](devcontainer.md#kubedock-and-task-identities)
ships its own local copy of this component (`SCOPE_DEV_KUBEDOCK=true`). Its scoped
RBAC has been verified, but no worker has run Docker operations through it yet,
so Kind worker support is not claimed.

Kubedock is deployed as a **Kustomize Component** that overlays opt into per environment.

### Enabling in an environment

Add to the overlay's `kustomization.yaml`:

```yaml
components:
  - ../../components/kubedock
```

### Disabling in an environment

Remove the component reference:

```diff
-components:
-  - ../../components/kubedock
```

No application code changes needed — `KubedockClient.isEnabled()` returns `false` when `KUBEDOCK_ENABLED` is unset.

### What the component injects

| Resource | Purpose |
|----------|---------|
| `serviceAccountName: kubedock-sa` | RBAC for creating pods in namespace |
| `DOCKER_HOST` env var | Points worker to kubedock Unix socket |
| `KUBEDOCK_ENABLED=true` env var | Activates container cleanup in app code |
| Kubedock sidecar container | Docker API → K8s translation |
| `kubedock-socket` volume | Shared Unix socket between sidecar and worker |
| `kubedock-config-vol` volume | Pod template for spawned containers |

## Application Code

### KubedockClient (`packages/shared/src/kubedock/`)

Lightweight HTTP client that talks to the Docker API over the Unix socket for cleanup operations.

```typescript
import { KubedockClient } from "shared";

// Check if kubedock is active (requires DOCKER_HOST + KUBEDOCK_ENABLED=true)
if (KubedockClient.isEnabled()) {
  const client = new KubedockClient();
  
  // Purge orphaned containers on setup
  await client.purgeContainers();
  
  // Remove specific containers on teardown
  const containers = await client.listContainers();
  for (const container of containers) {
    await client.removeContainer(container.Id);
  }
}
```

### Safety Guard

`KubedockClient.isEnabled()` requires **both**:
- `DOCKER_HOST` set to a `unix://` path
- `KUBEDOCK_ENABLED=true`

This prevents accidental container cleanup against a real Docker daemon (e.g., in Docker Compose local dev where the host socket is mounted directly).

### Subprocess Environment

ACP workers pass `DOCKER_HOST` to agent subprocesses via `buildSubprocessEnv()`:

```typescript
// In buildSubprocessEnv() — conditional passthrough
...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {})
```


## Kubedock Configuration

| Flag | Value | Purpose |
|------|-------|---------|
| `--port-forward` | — | Enables localhost access to spawned container ports |
| `--namespace` | `scoped` | Creates pods in the same namespace |
| `--timeout` | `60m` | Auto-kills containers after 60 minutes |
| `--reapmax` | `60m` | Maximum container lifetime |
| `--pod-template` | `/config/pod-template.json` | Template for spawned pods |
| `--unix-socket` | `/var/run/kubedock/kubedock.sock` | Socket path |

## Local Development (Docker Compose)

In Docker Compose, kubedock is **not used**. Instead, the host Docker socket is mounted directly into worker containers:

```yaml
# docker-compose.yml
volumes:
  - ${DOCKER_SOCK:-/var/run/docker.sock}:/var/run/docker.sock
environment:
  DOCKER_HOST: "unix:///var/run/docker.sock"
  # KUBEDOCK_ENABLED is intentionally NOT set — prevents cleanup of host containers
```

| Platform | DOCKER_SOCK | DOCKER_GID |
|----------|-------------|------------|
| Docker Desktop (macOS) | `/var/run/docker.sock` (default) | `0` (default) |
| Docker Engine (Linux) | `/var/run/docker.sock` (default) | `999` or `998` (docker group) |
| Podman (rootless) | `/run/podman/podman.sock` | `0` |

## RBAC

The `kubedock-sa` ServiceAccount has a Role granting:
- `pods`, `services`, `configmaps`: get, list, watch, create, update, patch, delete
- `pods/log`: get, list, watch, create, update, patch, delete
- `pods/exec`: get, list, watch, create, update, patch, delete
- `pods/portforward`: get, create

Scoped to the `scoped` namespace only. The RBAC resources (`kubedock-rbac.yaml`) live inside the Component — they are only deployed when the component is enabled.

## Architecture Constraints

### arm64 / Apple Silicon

The pinned image `joyrex2001/kubedock:0.17.0` is **amd64-only**. On arm64 hosts (e.g. Apple Silicon under Docker Desktop emulation), it crashes immediately with `fatal error: lfstack.push invalid packing`.

**This is correct for AKS** (amd64 nodes). For local ARM-based validation, temporarily use the multi-arch tag:

```yaml
image: joyrex2001/kubedock:latest  # multi-arch, includes arm64
```

Do not commit this change — it's for local testing only.

## Environment Variables

| Variable | Where Set | Purpose |
|----------|-----------|---------|
| `DOCKER_HOST` | K8s manifest / Compose | Unix socket path for Docker API |
| `KUBEDOCK_ENABLED` | K8s manifest only | Gates container cleanup (safety) |
| `DOCKER_SOCK` | Compose `.env` | Host socket path override (Podman/Linux) |
| `DOCKER_GID` | Compose `.env` | Socket group ID override |
