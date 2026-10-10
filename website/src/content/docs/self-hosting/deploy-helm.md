---
title: Deploy with Helm
description: Install and upgrade Scope on Kubernetes with helm install and helm upgrade.
---

This path installs the Scope chart from
[deploy/helm/scope](https://github.com/microsoft/scope/tree/main/deploy/helm/scope)
with the Helm CLI. Use it for a single environment, for a quick first
deployment, or when an existing CI/CD pipeline already runs Helm. To have
the cluster reconcile the release from Git instead, see
[Deploy with Flux](/self-hosting/deploy-flux/).

## Before you start

- A cluster that meets the [prerequisites](/self-hosting/overview/#prerequisites).
  On Azure, run [Provision AKS](/self-hosting/provision-aks/) first.
- `kubectl` pointing at the cluster. After `azd up`, run
  `az aks get-credentials --resource-group <rg> --name <cluster>`.
- [Helm](https://helm.sh/docs/intro/install/) 3 and a clone of
  `microsoft/scope` checked out at the release you want to deploy.
- The agent and model secrets in Key Vault. See
  [Secrets](/self-hosting/configuration/#secrets).

## 1. Publish the images

The chart pulls every component from one registry, under
`<registry>/scoped/<component>:<tag>`. Build the images from the repository
root and push them to your registry. With Azure Container Registry, ACR
Tasks build in Azure, so you don't need Docker locally:

```bash
ACR=<your-registry-name>          # for example, from AZURE_CONTAINER_REGISTRY_NAME
TAG=$(git rev-parse --short HEAD)

for app in api judge portal scheduler token-manager; do
  az acr build --registry "$ACR" --image "scoped/$app:$TAG" \
    --file "apps/$app/Dockerfile" .
done

for worker in coder-acp-copilot coder-acp-claude-code post-processor report-generator; do
  az acr build --registry "$ACR" --image "scoped/$worker:$TAG" \
    --file "apps/workers/$worker/Dockerfile" .
done

for scanner in copilot anthropic; do
  az acr build --registry "$ACR" --image "scoped/model-scanner-$scanner:$TAG" \
    --file "apps/model-scanners/$scanner/Dockerfile" .
done

az acr build --registry "$ACR" --image "scoped/db-migrations:$TAG" \
  --file packages/db-migrations/Dockerfile .
az acr build --registry "$ACR" --image "scoped/gateway:$TAG" apps/gateway
```

Use an immutable tag, such as the commit SHA, for every release. Don't
reuse tags: Kubernetes won't pull a changed image under the same tag.

The Portal reads its sign-in settings at **build time**. If you enable
[Entra sign-in](/self-hosting/configuration/#authentication), pass
`--build-arg VITE_AUTH_CLIENT_ID=...`, `VITE_AUTH_AUTHORITY`, and
`VITE_AUTH_SCOPES` when building `portal`.

The Windows Copilot worker builds from
[apps/workers/coder-acp-copilot-windows](https://github.com/microsoft/scope/tree/main/apps/workers/coder-acp-copilot-windows)
on a Windows build host. Skip it unless you enable Windows workers.

## 2. Write a values file

Create `scope-values.yaml` from the provisioning outputs. From the
`infra/aks` folder:

```bash
cat > scope-values.yaml <<EOF
image:
  registry: $(azd env get-value AZURE_CONTAINER_REGISTRY_ENDPOINT)
  tag: ${TAG}

azure:
  tenantId: $(azd env get-value AZURE_TENANT_ID)
  keyVault:
    uri: $(azd env get-value AZURE_KEYVAULT_URI)
  workloadIdentity:
    externalSecretsClientId: $(azd env get-value AZURE_IDENTITY_CLIENT_ID)
    tokenManagerClientId: $(azd env get-value KV_SECRETS_OFFICER_IDENTITY_CLIENT_ID)
  storage:
    accountName: $(azd env get-value AZURE_STORAGE_ACCOUNT_NAME)
    accountArmId: $(azd env get-value AZURE_STORAGE_ACCOUNT_ARM_ID)
  cosmosDb:
    accountArmId: $(azd env get-value AZURE_COSMOSDB_ACCOUNT_ARM_ID)
EOF
```

Every other value has a working default. See
[Configuration](/self-hosting/configuration/) to enable sign-in, choose
workers, expose the Portal, or adjust scaling. Keep the values file in
source control; it holds no secrets.

## 3. Install

```bash
helm upgrade --install scope ./deploy/helm/scope \
  --namespace scoped --create-namespace \
  --values scope-values.yaml \
  --wait --timeout 15m
```

The install runs in this order:

1. External Secrets creates the Kubernetes Secrets from Key Vault, and
   Azure Service Operator creates the queues, blob containers, and MongoDB
   database and collections.
2. The `db-migration` Job applies database migrations. API pods stay
   not-ready until migrations finish, because the API readiness probe
   checks the migrations collection.
3. The API, Portal, Judge, gateway, scheduler, and token manager start.
4. One registration Job per enabled worker registers the worker's agent
   version and queue with the API. The Jobs retry until the API is ready.

Workers start at zero replicas and scale up when runs are queued.

## 4. Verify

```bash
kubectl -n scoped get pods
kubectl -n scoped get jobs
kubectl -n scoped get externalsecrets,scaledobjects
```

All Deployments except the workers should be `Running` and ready, the
Jobs `Complete`, and every `ExternalSecret` `SecretSynced`.

Open the Portal through a port-forward. The Portal proxies `/api` to the
API, so one forward is enough:

```bash
kubectl -n scoped port-forward svc/portal 8080:80
```

Browse to `http://localhost:8080`, then follow
[Your first run](/getting-started/first-run/). To expose the Portal
permanently, see [Expose the Portal](/self-hosting/configuration/#expose-the-portal).

## Upgrade

Publish images for the new release, update `image.tag`, and run the same
command:

```bash
helm upgrade --install scope ./deploy/helm/scope \
  --namespace scoped --values scope-values.yaml \
  --wait --timeout 15m
```

Each upgrade reruns the migration and registration Jobs. Check the
chart's release notes before upgrading across versions. Migrations only
move forward, so take a database backup first if you may need to roll
back (see [Operations](/self-hosting/operations/#back-up-and-restore)).

## Roll back

```bash
helm history scope -n scoped
helm rollback scope <revision> -n scoped --wait
```

A rollback restores the previous images and settings. It doesn't undo
database migrations that the newer release applied.

## Uninstall

```bash
helm uninstall scope -n scoped
```

Kubernetes resources are removed. Azure Service Operator **keeps** the
Azure queues, blob containers, and MongoDB collections: the chart marks
them to be retained, so uninstalling never deletes run data. Delete the
Azure resources separately, or tear down the whole environment with
`azd down`.
