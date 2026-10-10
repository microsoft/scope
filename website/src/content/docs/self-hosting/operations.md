---
title: Operations
description: Upgrade, scale, monitor, back up, and troubleshoot a self-hosted Scope deployment on Kubernetes.
---

This page covers day-two tasks for a Scope deployment installed with
[Helm](/self-hosting/deploy-helm/) or [Flux](/self-hosting/deploy-flux/).
Commands assume the release is named `scope` and runs in the `scoped`
namespace.

## Upgrade Scope

1. Read the release notes for chart value changes and migrations.
2. Publish the images for the new release under a new tag. See
   [Publish the images](/self-hosting/deploy-helm/#1-publish-the-images).
3. Roll out:
   - **Helm**: update `image.tag` and run `helm upgrade`.
   - **Flux**: update `image.tag` and the `GitRepository` ref in Git, and
     merge.

Every upgrade runs the `db-migration` Job before the new pods start.
Migrations are forward-only, so a rollback restores the old code but not
the old schema. Back up first if you may need to return to the old data.

## Upgrade the infrastructure

Rerun `azd up` (or `azd provision`) from `infra/aks` after pulling a newer
version. Bicep applies changes in place. Provisioning also upgrades the
cluster add-ons to the versions pinned in the hooks. Kubernetes version
upgrades follow the AKS
[upgrade guidance](https://learn.microsoft.com/azure/aks/upgrade-aks-cluster);
the system and user pools upgrade node by node.

## Scale

| What | How |
| --- | --- |
| Parallel runs per agent | Raise `workers.<name>.maxReplicas`. |
| Worker nodes | Raise the `workers` pool maximum (5 by default) in the AKS Bicep module and rerun `azd provision`. |
| API, Portal, Judge | Raise `<component>.replicas` in the values. |
| Always-warm workers | Set `workers.<name>.minReplicas` above `0`. |

Keep worker replicas and worker nodes in step. When KEDA asks for more
pods than the `workers` pool can hold, the extra pods stay `Pending`
until the cluster autoscaler adds a node, or until the pool hits its
maximum.

## Rotate secrets

Update the value in Key Vault:

```bash
az keyvault secret set --vault-name <vault> --name <secret> --value "<new>"
```

External Secrets syncs the change within 5 minutes and the affected pods
restart automatically. To sync immediately:

```bash
kubectl -n scoped annotate externalsecret <name> \
  force-sync=$(date +%s) --overwrite
```

Infrastructure secrets such as the Redis password and storage connection
string are rewritten by provisioning. Rotate the key on the Azure
resource, then rerun `azd provision`.

## Monitor

Provisioning connects the cluster to Azure Monitor:

- **Application Insights** receives traces, logs, and metrics from every
  Scope service.
- **Container insights** and **Managed Prometheus** collect cluster and
  pod metrics, visualized in **Azure Managed Grafana**.
- **Alert rules** notify the action group set by `ALERT_EMAIL_RECIPIENTS`
  and `ALERT_WEBHOOK_URL`:

| Alert | Fires when |
| --- | --- |
| Pod restart loops | A pod enters `CrashLoopBackOff`. |
| Node not ready | A node leaves the `Ready` state. |
| Worker pod not ready | A worker pod has no ready containers for 5 minutes. |
| Stale runs | A worker starts a task but doesn't finish it within 5 minutes. |

Scope's own metrics and spans are described in
[Observability](https://github.com/microsoft/scope/blob/main/docs/architecture/observability.md).

## Back up and restore

Run data lives in Azure, outside the cluster:

| Data | Store | Protection |
| --- | --- | --- |
| Runs, criteria, profiles, results | Cosmos DB for MongoDB | Cosmos DB backups |
| Logs, snapshots, reports | Blob Storage | Soft delete and versioning |
| Secrets | Key Vault | Soft delete (7 days); enable purge protection for production |
| Queues, cache | Storage queues, Redis | Transient; not backed up |

Cosmos DB takes periodic backups by default. For self-service
point-in-time restore, switch the account to
[continuous backup](https://learn.microsoft.com/azure/cosmos-db/continuous-backup-restore-introduction).

The cluster holds no state you can't recreate. To rebuild a cluster,
provision it and reinstall the chart with the same values.

## Automate deployments

Run provisioning and releases from GitHub Actions without stored
credentials by using
[OpenID Connect](https://docs.github.com/actions/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-azure):

1. Create a GitHub environment per Scope environment, such as
   `integration` and `production`.
2. Add a federated credential to a deployment identity with the subject
   `repo:<owner>/<repo>:environment:<environment>`, and grant it access to
   the subscription.
3. In the workflow, sign in with `azure/login`, then run `azd provision`
   and either `helm upgrade` or a commit that Flux picks up.

Run `azd provision --preview` on pull requests to show infrastructure
changes before they merge.

## Troubleshoot

Start with an overview of the namespace:

```bash
kubectl -n scoped get pods,jobs,externalsecrets,scaledobjects
kubectl -n scoped get events --sort-by=.lastTimestamp | tail -20
```

### Pods stay Pending

Run `kubectl -n scoped describe pod <pod>` and read the events.

- **Untolerated taint**: Scope pods land on the `apps` and `workers`
  pools by label. A custom cluster needs matching node labels, or
  overridden `nodeSelector` and `tolerations` values.
- **Insufficient CPU or memory**: the pool is at its maximum. Raise the
  pool's maximum count or lower `maxReplicas`.

### ExternalSecret shows SecretSyncedError

```bash
kubectl -n scoped describe externalsecret <name>
```

- **Secret not found**: the Key Vault secret is missing. Add it; see
  [Secrets](/self-hosting/configuration/#secrets).
- **403 Forbidden**: the External Secrets identity lacks
  **Key Vault Secrets User**, or `azure.workloadIdentity.externalSecretsClientId`
  doesn't match the identity's client ID.
- Pods that need the Secret wait in `CreateContainerConfigError` until it
  syncs.

### API never becomes ready

The API readiness probe waits for migrations. Check the Job:

```bash
kubectl -n scoped logs job/db-migration
```

Connection errors point to the `mongo-secrets` Secret. A failed
migration leaves the previous schema in place; fix the cause and rerun
the upgrade.

### Workers don't start for queued runs

```bash
kubectl -n scoped describe scaledobject <worker>
kubectl -n keda logs deploy/keda-operator | tail -50
```

- The `ScaledObject` must be `Ready` and `Active`. If not, check the
  `TriggerAuthentication` and the `worker-secrets` Secret it reads.
- The queue must be named `queue-<worker>` and exist in the storage
  account.
- If the run stays queued with no message on the queue, check that the
  worker's registration Job completed.

### Azure resources aren't created

Azure Service Operator reports each resource's status as a condition:

```bash
kubectl -n scoped get storageaccountsqueueservicesqueues,mongodbdatabases
kubectl -n scoped describe <kind> <name>
```

A `Ready=False` condition carries the Azure error. Most failures are
missing role assignments on the ASO identity or a wrong
`azure.*.accountArmId`.

### Portal loads but sign-in fails

- The Portal image was built without the `VITE_AUTH_*` arguments. Rebuild
  it; see [Authentication](/self-hosting/configuration/#authentication).
- The Portal URL isn't a redirect URI on the SPA registration.
- The API rejects tokens: `auth.entra.authority` or `auth.entra.apiClientId`
  doesn't match the registration.

For problems that aren't specific to Kubernetes, see
[Troubleshooting](/resources/troubleshooting/).
