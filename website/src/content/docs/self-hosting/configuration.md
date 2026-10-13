---
title: Configuration
description: Configure Scope's Helm values, identities, secrets, workers, authentication, and ingress.
---

Layer a private values file over
[`deploy/helm/scope/values.yaml`](https://github.com/microsoft/scope/blob/main/deploy/helm/scope/values.yaml).
Generate the Azure-specific values with
`scripts/generate-values-from-bicep.sh`, then add only your overrides.
The same values work for `helm install` and for a Flux `HelmRelease`; only
where you write them differs.

| Path | Where values live |
| --- | --- |
| [Helm](/self-hosting/deploy-helm/) | your values file, passed with `--values` |
| [Flux](/self-hosting/deploy-flux/) | `spec.values` and `spec.valuesFrom` in the `HelmRelease` |

## Global values

| Value | Default | Purpose |
| --- | --- | --- |
| `global.namespace` | `scope` | Namespace encoded in the federated identities |
| `global.imageRegistry` | `ghcr.io/microsoft` | Core image registry |
| `global.imageTag` | `latest` | Default core image tag |
| `global.imagePullPolicy` | `IfNotPresent` | Pull policy |
| `global.imagePullSecrets` | `[]` | Optional registry credentials |

Each service has `enabled`, `image`, `replicas`, and `resources` values.
The API and Portal also have ingress values, and the Judge has model and
strategy values.

## Azure values

The generator fills these values from the Bicep deployment:

```yaml
azure:
  tenantId: <tenant-id>
  keyVaultName: <vault-name>
  keyVaultUri: https://<vault-name>.vault.azure.net/
  workloadIdentityClientId: <backend-client-id>
  serviceAccountName: scope-workload-identity
  storageAccountName: <storage-account>
  redisHostName: <redis-host>
  redisPort: <redis-port>
  redisTls: true
  workerWorkloadIdentityClientId: <worker-client-id>
  workerServiceAccountName: scope-worker-workload-identity
```

The backend identity is used by trusted application components. The worker
identity has Storage Blob and Queue roles only and no Key Vault role.

## Secrets

The chart creates one `SecretProviderClass`. The API mounts its CSI volume,
which causes the provider to sync selected Key Vault objects into one
Kubernetes Secret:

```yaml
secrets:
  k8sSecretName: scope-secrets
  keyVaultSecretNames:
    mongoConnectionString: cosmos-connection-string
    redisPassword: redis-primary-key
    githubToken: ""
    anthropicApiKey: ""
```

| Key Vault object | Kubernetes key / environment variable |
| --- | --- |
| `cosmos-connection-string` | `MONGO_CONNECTION_STRING` |
| `redis-primary-key` | `REDIS_PASSWORD` |
| Optional GitHub token object | `GITHUB_TOKEN` |
| Optional Anthropic key object | `ANTHROPIC_API_KEY` |

At least one pod must mount the CSI volume for Kubernetes Secret sync to
occur. The Azure provider fails the entire mount if any requested object is
missing, so leave optional object names empty until those objects exist.

Storage access uses workload identity and RBAC. It does not use a storage
connection-string secret.

### Provider credentials

Prefer dynamic registration through the Portal's **Secrets** tab or
`POST /api/v1/keys`. Token Manager writes registered credentials to Key Vault
using the backend identity.

The Copilot worker requires a scopeless GitHub OAuth token, not a personal
access token. Generate one with:

```bash
pnpm get-copilot-token
```

Static `githubToken` and `anthropicApiKey` Key Vault objects are fallback
environment variables. Set their object names in Helm values only after the
objects exist.

## Core services

The sections are:

- `api`
- `portal`
- `judge`
- `tokenManager`
- `scheduler`
- `workers.reportGenerator`
- `jobs.dbMigrate`

The migration Job uses the API builder image. Its tag defaults to `builder`,
or `builder-<global.imageTag>` when the global tag is pinned.

## Coding-agent workers

The worker sections are `workers.coderAcpCopilot` and
`workers.coderAcpClaudeCode`. Both are disabled by default.

```yaml
workers:
  coderAcpCopilot:
    enabled: false
    image:
      registry: <acr>.azurecr.io
      repository: scope-coder-acp-copilot
      tag: <tag>
    queueName: queue-coder-acp-copilot
    agentVersion: copilot-dev
    replicas: 1
    mcpGateway:
      enabled: true
```

Use fixed `replicas` values. `queueName` and `agentVersion` must match the
registered agent-version manifest. The bootstrap script configures the image,
enables the Deployment, and registers the agent type.

The optional `mcpGateway` is an MCPJungle native sidecar. The chart does not
template the AI Gateway/DevProxy sidecar or Kubedock.

## Authentication

The chart exposes only `portal.authEnabled`. It defaults to `false` because
the public Portal image has no deployment-specific Entra app registration.

Full authentication is not configured by this chart. Enabling it requires a
custom Portal image with the required `VITE_AUTH_*` build values, an Entra
application registration, and API authentication environment wiring that the
chart does not currently expose.

## Ingress

The API and Portal have separate settings:

```yaml
api:
  ingress:
    enabled: false
    className: ""
    host: ""
    tls: []

portal:
  ingress:
    enabled: false
    className: ""
    host: ""
    tls: []
```

The chart creates Ingress objects only when enabled. It does not install an
ingress controller, configure DNS, issue certificates, or expose a
`Service.type` value. Bring those prerequisites yourself.
