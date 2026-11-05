// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

@description('Azure region for all resources.')
param location string

@description('Tags to apply to all resources.')
param tags object = {}

@description('Name of the AKS cluster.')
@minLength(1)
@maxLength(63)
param aksName string

@description('Kubernetes version. Leave empty to use the AKS default.')
param kubernetesVersion string = ''

@description('Resource ID of the subnet to deploy AKS node pools into.')
param vnetSubnetResourceId string

// Defaults are deliberately small rather than production-sized: 1 System
// node + 2 User nodes keeps the total footprint to 3 nodes / 6 vCPUs, still
// comfortably inside the common 10-vCPU default regional quota many
// subscriptions start with. The User pool defaults to 2 nodes (not 1) to
// leave CPU headroom for an optional ACP worker pod - see the userNodeCount
// comment below. This trades away multi-node HA for the System pool - fine
// for a quickstart/dev deployment, but bump systemNodeCount to 3 for a
// production environment.
// Standard_D2s_v5 (general-purpose, non-burstable) is used instead of a
// B-series burstable size because SKU availability for a given vCPU family
// varies a lot by subscription/region (e.g. some subscriptions only allow
// the newer "_v2" B-series, not classic B2ms) - Dsv5 is broadly available
// and matches the 2 vCPU / 8 GiB memory profile this template is sized for.
@description('VM size for the System node pool. Defaults to a modest, broadly-available general-purpose size; use a larger size (e.g. Standard_D4s_v5) for production.')
param systemNodeVmSize string = 'Standard_D2s_v5'

@description('Node count for the System node pool. Defaults to 1 for a minimal/dev footprint; use 3+ for production HA.')
param systemNodeCount int = 1

@description('VM size for the User node pool. Defaults to a modest, broadly-available general-purpose size; use a larger size (e.g. Standard_D4s_v5) for production.')
param userNodeVmSize string = 'Standard_D2s_v5'

// Defaults to 2 (not 1) because the core app alone (api/portal/judge/
// token-manager/scheduler/report-generator) already consumes ~85% of a
// single Standard_D2s_v5 node's allocatable CPU, leaving no room to
// schedule an optional Phase 3 ACP worker pod (coder-acp-copilot: 500m main
// + 250m MCP-gateway sidecar = 750m) on top - confirmed live via
// `Insufficient cpu` scheduling failures with a single user node.
@description('Node count for the User node pool. Defaults to 2 to leave CPU headroom for an optional ACP worker pod alongside the core app; 1 is enough for the core app alone, but scale up further for production workloads.')
param userNodeCount int = 2

// publicNetworkAccess is explicitly set to 'Enabled' (overriding the module's
// 'Disabled' default) rather than enabling enablePrivateCluster, because this
// is a public open-source quickstart template: it needs to let a developer
// run `az aks get-credentials` + `kubectl`/`helm` straight from their own
// machine without standing up a jumpbox or VPN. Only the data-plane services
// (Key Vault, Storage, Cosmos DB, etc.) are placed behind private endpoints;
// the AKS API server stays reachable over its public, AAD/kubeconfig-secured
// endpoint. No authorizedIPRanges allowlist is configured for the same reason.
module managedCluster 'br/public:avm/res/container-service/managed-cluster:0.14.0' = {
  name: 'aks-deployment'
  params: {
    name: aksName
    location: location
    tags: tags
    kubernetesVersion: empty(kubernetesVersion) ? null : kubernetesVersion
    managedIdentities: {
      systemAssigned: true
    }
    networkPlugin: 'azure'
    networkPluginMode: 'overlay'
    networkPolicy: 'cilium'
    networkDataplane: 'cilium'
    publicNetworkAccess: 'Enabled'
    apiServerAccessProfile: {
      enablePrivateCluster: false
    }
    // Local accounts are kept enabled (the module default is to disable
    // them) because this template does not wire up Entra ID/AAD cluster
    // admin group integration, so `az aks get-credentials` relies on the
    // cluster's local admin credentials to produce a working kubeconfig.
    disableLocalAccounts: false
    enableOidcIssuerProfile: true
    securityProfile: {
      workloadIdentity: {
        enabled: true
      }
    }
    // Native Key Vault Secrets Provider add-on replaces External Secrets
    // Operator for syncing Key Vault secrets into the cluster; do not add
    // ESO, Flux, or ASO alongside this.
    enableKeyvaultSecretsProvider: true
    enableSecretRotation: true
    // availabilityZones is explicitly set to an empty array rather than
    // relying on the AVM module's default of [1,2,3]: not every region
    // supports availability zones for AKS node pools (e.g. centralus), and
    // requesting zones in an unsupported region fails deployment with
    // AvailabilityZoneNotSupported. This quickstart favors broad regional
    // compatibility over zone-redundant HA; set this explicitly in regions
    // that support it for a production environment.
    primaryAgentPoolProfiles: [
      {
        name: 'system'
        mode: 'System'
        osType: 'Linux'
        vmSize: systemNodeVmSize
        count: systemNodeCount
        vnetSubnetResourceId: vnetSubnetResourceId
        availabilityZones: []
      }
    ]
    agentPools: [
      {
        name: 'user'
        mode: 'User'
        osType: 'Linux'
        vmSize: userNodeVmSize
        count: userNodeCount
        vnetSubnetResourceId: vnetSubnetResourceId
        availabilityZones: []
      }
    ]
  }
}

output aksResourceId string = managedCluster.outputs.resourceId
output aksName string = managedCluster.outputs.name
output oidcIssuerUrl string = managedCluster.outputs.?oidcIssuerUrl ?? ''
output kubeletIdentityObjectId string = managedCluster.outputs.?kubeletIdentityObjectId ?? ''
output aksSystemAssignedIdentityPrincipalId string = managedCluster.outputs.?systemAssignedMIPrincipalId ?? ''
