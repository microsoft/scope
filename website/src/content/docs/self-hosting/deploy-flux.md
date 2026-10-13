---
title: Deploy with Flux
description: Run Scope from Git with Flux, a GitRepository, and a HelmRelease.
---

This path hands the release to [Flux](https://fluxcd.io/). You describe
the Scope release in Git as a `HelmRelease`, and Flux's Helm controller
installs it and keeps the cluster in sync with Git. Use it for long-lived
environments, for several environments promoted from one repository, or
when changes should go through pull requests rather than a terminal.

Flux installs the same chart as [Deploy with Helm](/self-hosting/deploy-helm/),
so every value in [Configuration](/self-hosting/configuration/) applies to
both paths.

## How it fits together

```text
your config repo                    AKS cluster
----------------                    -----------
clusters/prod/                      flux-system
  scope-source.yaml   --- pull -->    GitRepository scope
  scope-release.yaml  --- pull -->    HelmRelease   scope
                                      ConfigMap     infra-outputs
microsoft/scope                              |
  deploy/helm/scope   <-- chart --           | helm install / upgrade
                                             v
                                    scoped
                                      API, Portal, Judge, workers, ...
```

- A `GitRepository` points at `microsoft/scope` (or your fork) at a
  branch, tag, or commit. Flux reads the chart from `deploy/helm/scope`.
- A `HelmRelease` names the chart, the target namespace, and the values.
- The `infra-outputs` ConfigMap, written by provisioning, supplies the
  Azure-specific values. You don't copy them by hand.

## Before you start

- A cluster provisioned with **Flux enabled**. With
  [Provision AKS](/self-hosting/provision-aks/), set the flag before
  `azd up`:

  ```bash
  azd env set DEPLOY_FLUX true
  azd up
  ```

  Provisioning then installs the
  [Flux Operator](https://fluxcd.control-plane.io/operator/), creates a
  `FluxInstance` running Flux 2.7, and writes the `infra-outputs`
  ConfigMap into `flux-system`. Flux controllers run on the system node
  pool.

  On another cluster, install Flux with
  [flux bootstrap](https://fluxcd.io/flux/installation/) or the Flux
  Operator, and create `infra-outputs` yourself with the keys listed in
  [Provisioning outputs](/self-hosting/provision-aks/#outputs).
- The images for the release in your registry. See
  [Publish the images](/self-hosting/deploy-helm/#1-publish-the-images).
- The [Flux CLI](https://fluxcd.io/flux/installation/#install-the-flux-cli)
  for inspecting and triggering reconciliation.

Check that Flux is healthy and the ConfigMap exists:

```bash
flux check
kubectl -n flux-system get configmap infra-outputs -o yaml
```

## 1. Add the source

`scope-source.yaml` tells Flux where to fetch the chart. Pin production
to a tag or a commit:

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: scope
  namespace: flux-system
spec:
  interval: 10m
  url: https://github.com/microsoft/scope
  ref:
    tag: v1.2.0          # or: branch: main / commit: <sha>
  ignore: |
    /*
    !/deploy/helm/scope
```

The `ignore` rule keeps the artifact small by fetching only the chart.

## 2. Add the release

`scope-release.yaml` installs the chart into the `scoped` namespace. The
Azure values come from `infra-outputs`; everything else lives inline or
in a ConfigMap you manage:

```yaml
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: scope
  namespace: flux-system
spec:
  interval: 10m
  targetNamespace: scoped
  install:
    createNamespace: true
    remediation:
      retries: 3
  upgrade:
    remediation:
      retries: 3
      remediateLastFailure: true
  timeout: 15m
  chart:
    spec:
      chart: ./deploy/helm/scope
      sourceRef:
        kind: GitRepository
        name: scope
      reconcileStrategy: Revision
  valuesFrom:
    - kind: ConfigMap
      name: infra-outputs
      valuesKey: AZURE_CONTAINER_REGISTRY_ENDPOINT
      targetPath: image.registry
    - kind: ConfigMap
      name: infra-outputs
      valuesKey: AZURE_TENANT_ID
      targetPath: azure.tenantId
    - kind: ConfigMap
      name: infra-outputs
      valuesKey: AZURE_KEYVAULT_URI
      targetPath: azure.keyVault.uri
    - kind: ConfigMap
      name: infra-outputs
      valuesKey: AZURE_IDENTITY_CLIENT_ID
      targetPath: azure.workloadIdentity.externalSecretsClientId
    - kind: ConfigMap
      name: infra-outputs
      valuesKey: KV_SECRETS_OFFICER_IDENTITY_CLIENT_ID
      targetPath: azure.workloadIdentity.tokenManagerClientId
    - kind: ConfigMap
      name: infra-outputs
      valuesKey: AZURE_STORAGE_ACCOUNT_NAME
      targetPath: azure.storage.accountName
    - kind: ConfigMap
      name: infra-outputs
      valuesKey: AZURE_STORAGE_ACCOUNT_ARM_ID
      targetPath: azure.storage.accountArmId
    - kind: ConfigMap
      name: infra-outputs
      valuesKey: AZURE_COSMOSDB_ACCOUNT_ARM_ID
      targetPath: azure.cosmosDb.accountArmId
  values:
    image:
      tag: 3f9c2ab       # the image tag you published
    workers:
      coder-acp-claude-code:
        enabled: true
```

`reconcileStrategy: Revision` makes Flux repackage the chart whenever
the Git revision changes, so a new tag or commit rolls out without a
chart version bump.

## 3. Commit and reconcile

Commit both files to the path Flux watches for the cluster, then let Flux
pick them up or trigger it:

```bash
flux reconcile source git scope
flux reconcile helmrelease scope -n flux-system
flux get helmreleases -n flux-system
```

The release becomes `Ready` once the install finishes. The install runs
the same steps as the Helm path: secrets and Azure resources, the
migration Job, the services, then worker registration. Verify it the same
way, as described in [Verify](/self-hosting/deploy-helm/#4-verify).

## Upgrade and promote

Change Git, not the cluster:

- **New release**: publish images, then update `image.tag` and the
  `GitRepository` `ref` in one pull request.
- **Configuration change**: edit `values` and merge.

A common layout runs one cluster per environment, each watching its own
folder:

| Environment | `GitRepository` ref | `image.tag` |
| --- | --- | --- |
| Integration | `branch: main` | latest build of `main` |
| Production | `tag: v1.2.0` | the tag's build |

Promote by copying the integration values to the production folder in a
pull request. Rolling back is a revert of that pull request.

Helm's own history still works: `helm history scope -n scoped` lists the
revisions Flux created. With `remediateLastFailure: true`, Flux rolls a
failed upgrade back automatically.

## Pause reconciliation

Suspend a release while you debug or patch something live, then resume
it to return to the Git state:

```bash
flux suspend helmrelease scope -n flux-system
flux resume helmrelease scope -n flux-system
```

## Private forks

If the `GitRepository` points at a private fork, authenticate Flux with
a [GitHub App](https://fluxcd.io/flux/components/source/gitrepositories/#github).
Create a Secret named `flux-github-app` in `flux-system` with the keys
`githubAppID`, `githubAppInstallationID`, and `githubAppPrivateKey`, then
reference it:

```yaml
spec:
  provider: github
  secretRef:
    name: flux-github-app
```

To keep the Secret in Key Vault, store the three values there and sync
them with an `ExternalSecret` that uses the `azure-keyvault`
`ClusterSecretStore`, as the chart does for its own secrets.

## Automate image updates

Flux can also bump `image.tag` for you. The
[image automation controllers](https://fluxcd.io/flux/guides/image-update/),
which the Flux Operator installs, scan your registry, select a tag with
an `ImagePolicy`, and commit the new tag to Git. On AKS, set
`provider: azure` on the `ImageRepository`, so the controller reads ACR
with the kubelet identity, which already has pull access. Image
automation needs a Git credential with write access to the config repo.

## Remove

Delete the `HelmRelease` from Git. Flux uninstalls the release on the
next reconcile. As with `helm uninstall`, the Azure queues, blob
containers, and collections are retained.
