# Scope Helm chart

Installs the Scope application onto the AKS cluster provisioned by
[`deploy/azure/`](../azure/README.md) (the "Deploy to Azure" Bicep template).

> **Status**: skeleton. Only the `api` service is fully templated so far
> (deployment, service, ingress) along with the shared infrastructure
> (ServiceAccount, SecretProviderClass, common-env ConfigMap). `portal`,
> `judge`, `token-manager`, `scheduler`, and the workers are configured in
> `values.yaml` but their templates are follow-up work.

## What this does **NOT** automate

- Provisioning Azure infrastructure — that's `deploy/azure/`.
- Populating bring-your-own secrets in Key Vault (GitHub token, Anthropic API
  key, etc.) — add those yourself before or after installing this chart.
- Building/pushing container images to a registry — point `global.imageRegistry`
  at your own registry (e.g. the Bicep-provisioned ACR) and build/push images
  from this repo's Dockerfiles.
- TLS/cert-manager or DNS — bring your own ingress controller and certificates.

## Prerequisites

- An AKS cluster with:
  - The **Azure Key Vault Secrets Provider** CSI driver add-on enabled
    (`--enable-addons azure-keyvault-secrets-provider`)
  - **OIDC issuer** + **workload identity** enabled
  - A user-assigned managed identity federated to
    `system:serviceaccount:<namespace>:<serviceAccountName>`, granted
    `Key Vault Secrets User` on the Key Vault and
    `Storage Blob Data Contributor` + `Storage Queue Data Contributor` on the
    Storage account

  All of the above is exactly what `deploy/azure/main.bicep` provisions.

- `helm` and `kubectl` configured against the target cluster.

## Install

Read the Bicep deployment's outputs and populate a values override file:

```bash
az deployment group show \
  --resource-group <resource-group-name> \
  --name <deployment-name> \
  --query properties.outputs -o json
```

```yaml
# my-values.yaml
global:
  namespace: scope
  imageRegistry: <acrLoginServer>

azure:
  tenantId: <your-tenant-id>
  keyVaultName: <keyVaultName>
  workloadIdentityClientId: <workloadIdentityClientId>
  serviceAccountName: <workloadIdentityServiceAccountName>
  storageAccountName: <storageAccountName>

api:
  ingress:
    enabled: true
    host: api.example.com
```

```bash
kubectl create namespace scope
helm install scope deploy/helm/scope -n scope -f my-values.yaml
```

## Configuration

See [`values.yaml`](./values.yaml) for the full set of configurable values —
every service section supports `enabled`, `image.{repository,tag}`,
`replicas`, and `resources`.

### Secrets

Two Azure auth patterns are used side by side:

1. **CSI-synced secrets** (static values like connection strings and API
   keys): listed in `secrets.keyVaultSecretNames`, synced from Key Vault into
   a single Kubernetes `Secret` (`secrets.k8sSecretName`) by the
   `SecretProviderClass`, and consumed via `envFrom.secretRef`.
   `mongoConnectionString` and `redisConnectionString` are pre-populated in
   Key Vault by `deploy/azure/`; everything else is bring-your-own.
2. **Direct workload identity** (in-process `DefaultAzureCredential` calls):
   used for Blob/Queue Storage access (RBAC-only, no secret needed) and by
   `token-manager`, which calls the Key Vault SDK directly for live token
   round-robin management.

All Azure-dependent Pods run under the shared ServiceAccount named by
`azure.serviceAccountName`, which must match the Bicep template's federated
subject.
