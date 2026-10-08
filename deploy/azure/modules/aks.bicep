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

@description('VM size for the System node pool.')
param systemNodeVmSize string = 'Standard_D4s_v5'

@description('Node count for the System node pool.')
param systemNodeCount int = 3

@description('VM size for the User node pool.')
param userNodeVmSize string = 'Standard_D4s_v5'

@description('Node count for the User node pool.')
param userNodeCount int = 2

// publicNetworkAccess is explicitly set to 'Enabled' (overriding the module's
// 'Disabled' default) rather than enabling enablePrivateCluster, because this
// is a public open-source quickstart template: it needs to let a developer
// run `az aks get-credentials` + `kubectl`/`helm` straight from their own
// machine without standing up a jumpbox or VPN. Only the data-plane services
// (Key Vault, Storage, Cosmos DB, etc.) are placed behind private endpoints;
// the AKS API server stays reachable over its public, AAD/kubeconfig-secured
// endpoint. No authorizedIPRanges allowlist is configured for the same reason.
module managedCluster 'br/public:avm/res/container-service/managed-cluster:0.9.0' = {
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
    enablePrivateCluster: false
    // Local accounts are kept enabled (the module default is to disable
    // them) because this template does not wire up Entra ID/AAD cluster
    // admin group integration, so `az aks get-credentials` relies on the
    // cluster's local admin credentials to produce a working kubeconfig.
    disableLocalAccounts: false
    enableOidcIssuerProfile: true
    enableWorkloadIdentity: true
    // Native Key Vault Secrets Provider add-on replaces External Secrets
    // Operator for syncing Key Vault secrets into the cluster; do not add
    // ESO, Flux, or ASO alongside this.
    enableKeyvaultSecretsProvider: true
    enableSecretRotation: true
    primaryAgentPoolProfiles: [
      {
        name: 'system'
        mode: 'System'
        osType: 'Linux'
        vmSize: systemNodeVmSize
        count: systemNodeCount
        vnetSubnetResourceId: vnetSubnetResourceId
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
      }
    ]
  }
}

output aksResourceId string = managedCluster.outputs.resourceId
output aksName string = managedCluster.outputs.name
output oidcIssuerUrl string = managedCluster.outputs.?oidcIssuerUrl ?? ''
output kubeletIdentityObjectId string = managedCluster.outputs.?kubeletIdentityObjectId ?? ''
output aksSystemAssignedIdentityPrincipalId string = managedCluster.outputs.?systemAssignedMIPrincipalId ?? ''
