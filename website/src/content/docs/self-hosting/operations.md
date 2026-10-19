---
title: Operations
description: Upgrade, scale, rotate secrets, monitor, back up, and troubleshoot a self-hosted Scope deployment.
---

This page covers deployments provisioned from `deploy/azure` and installed
with [Helm](https://helm.sh/docs/) by following
[Deploy with Helm](/self-hosting/deploy-helm/).

## Upgrade the application

Pin a core image revision in your values file, then apply the chart:

```bash
helm upgrade scope deploy/helm/scope \
  --namespace scope \
  -f my-values.yaml \
  --wait \
  --timeout 5m
```

The post-upgrade `scope-db-migrate` Job runs the matching API builder image.
Inspect it with:

```bash
kubectl -n scope get jobs
kubectl -n scope logs job/scope-db-migrate
```

Re-run `scripts/bootstrap-workers.sh` when updating worker images or agent
versions. Pass `--values-file my-values.yaml` so new chart defaults are
merged instead of relying on a frozen `--reuse-values` snapshot.

## Upgrade infrastructure

Pull the desired repository revision, review the Bicep change, then rerun the
group deployment:

```bash
az deployment group what-if \
  --resource-group <resource-group> \
  --template-file deploy/azure/main.bicep \
  --parameters deploy/azure/main.parameters.json \
  --parameters environmentName=<environment> location=<region>

az deployment group create \
  --resource-group <resource-group> \
  --template-file deploy/azure/main.bicep \
  --parameters deploy/azure/main.parameters.json \
  --parameters environmentName=<environment> location=<region>
```

`deploy/azure/azuredeploy.json` is a committed compiled artifact for the
Deploy to Azure button. CI rebuilds `main.bicep` and rejects drift. Regenerate
and commit the JSON whenever the Bicep modules change.

## Scale

Application components use fixed Deployment replica counts:

```bash
helm upgrade scope deploy/helm/scope \
  -n scope \
  -f my-values.yaml \
  --set workers.reportGenerator.replicas=2
```

Set `aksSystemNodeCount` and `aksUserNodeCount` in the Bicep deployment to
change cluster capacity. Version 1 does not configure workload or cluster
autoscaling.

## Rotate secrets

Token Manager is the preferred path for provider credentials. Replace or
register credentials in the Portal's **Secrets** tab or through its API.

The AKS Key Vault Secrets Provider add-on has rotation enabled. For static
Key Vault objects, update the object, wait for CSI rotation, and restart the
consumer if the process does not reload environment variables:

```bash
kubectl -n scope rollout restart deployment/scope-api
```

When adding a previously empty optional secret name, update the Key Vault
object first, then run `helm upgrade`. A missing requested object prevents
the entire CSI mount and Kubernetes Secret sync.

## Observe the deployment

The Azure template does not provision Log Analytics, Application Insights,
Managed Prometheus, Grafana, dashboards, or alerts. Add your own monitoring
stack and retention policy.

Start with Kubernetes status and logs:

```bash
kubectl -n scope get pods,deployments,services,jobs
kubectl -n scope get events --sort-by=.lastTimestamp
kubectl -n scope logs deployment/scope-api
kubectl -n scope logs deployment/scope-coder-acp-copilot -c coder-acp-copilot
```

## Backup and recovery

- Cosmos DB uses serverless throughput and Microsoft's service-managed
  backup behavior. Choose a stronger backup policy if your recovery
  requirements demand it.
- Key Vault purge protection is enabled with 90-day soft-delete retention.
- Storage disables public and shared-key access and is reachable through
  private endpoints. The template does not enable blob versioning or
  soft-delete.

Keep your Helm values and infrastructure parameters in private source
control. Do not commit credentials.

## CI/CD

The repository ships core image publication on `main` and compiled-Bicep
drift validation. It does not ship an environment deployment pipeline.

A bring-your-own pipeline can authenticate with workload identity, run
`az deployment group what-if` and `create`, generate values, and apply Helm.
Protect values and provider credentials with your CI system's secret store.

## Troubleshoot

### Bicep deployment or private DNS fails

Inspect the deployment operations:

```bash
az deployment operation group list \
  --resource-group <resource-group> \
  --name <deployment-name> \
  --output table
```

Verify the account has permission to create role assignments. From an AKS
pod, confirm the private names for Key Vault, Cosmos DB, Redis, Blob, and
Queue resolve to private addresses.

### Pods cannot mount Key Vault secrets

```bash
kubectl -n scope describe secretproviderclass scope-azure-kv
kubectl -n scope describe pod <pod>
kubectl -n kube-system logs \
  -l app=csi-secrets-store-provider-azure \
  --tail=200
```

Confirm the backend client ID, tenant ID, vault name, federated
service-account subject, and Key Vault role. Remove optional object names
whose Key Vault objects do not exist; one missing object blocks the entire
mount.

### Database migration fails

```bash
kubectl -n scope get job scope-db-migrate
kubectl -n scope logs job/scope-db-migrate
```

Confirm the `scope-secrets` Secret contains `MONGO_CONNECTION_STRING` and
that the Job uses the `builder` or matching `builder-<sha>` API image.

### Worker bootstrap or rollout fails

Run the bootstrap script with the original values file and inspect:

```bash
kubectl -n scope get deployments,pods
kubectl -n scope describe deployment scope-coder-acp-copilot
kubectl -n scope get events --sort-by=.lastTimestamp
```

Check ACR pull access, the worker identity client ID, the image tag, and the
rollout. `queueName` and `agentVersion` must match the registered manifest.
Register provider credentials separately through Token Manager; the bootstrap
script does not do this.

### Ingress is unreachable

The chart does not install an ingress controller or configure DNS and TLS.
Confirm those user-managed prerequisites before debugging the generated
Ingress objects.
