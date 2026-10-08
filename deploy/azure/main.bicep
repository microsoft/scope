// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// ---------------------------------------------------------------------------
// Scope — "Deploy to Azure" infrastructure template
//
// Sanitized, resource-group-scoped Bicep template that provisions the Azure
// infrastructure needed to run Scope: an AKS cluster (with the native Key
// Vault Secrets Provider add-on, OIDC issuer, and workload identity enabled),
// a VNet with private endpoints for Key Vault/Cosmos DB/Redis/Storage, an
// Azure Container Registry, Cosmos DB (MongoDB API), Azure Cache for Redis,
// and a Storage account (blob + queue).
//
// This template does NOT install the Scope application itself (that's a Helm
// install performed separately — see deploy/azure/README.md) and does NOT
// provision any observability/monitoring resources (no Log Analytics,
// Grafana, or alerting) in this v1.
// ---------------------------------------------------------------------------

targetScope = 'resourceGroup'

@description('A short name for this environment/deployment, used to derive resource names (e.g. "scope-demo"). Lowercase alphanumeric and hyphens only.')
@minLength(3)
@maxLength(20)
param environmentName string

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Tags to apply to all resources.')
param tags object = {}

@description('Kubernetes version for the AKS cluster. Leave empty to use the AKS default.')
param kubernetesVersion string = ''

@description('VM size for the AKS System node pool.')
param aksSystemNodeVmSize string = 'Standard_D4s_v5'

@description('Node count for the AKS System node pool.')
@minValue(1)
param aksSystemNodeCount int = 3

@description('VM size for the AKS User node pool.')
param aksUserNodeVmSize string = 'Standard_D4s_v5'

@description('Node count for the AKS User node pool.')
@minValue(1)
param aksUserNodeCount int = 2

@description('SKU for the Azure Container Registry.')
@allowed([
  'Basic'
  'Standard'
  'Premium'
])
param acrSkuName string = 'Standard'

@description('Default consistency level for the Cosmos DB account.')
@allowed([
  'Eventual'
  'ConsistentPrefix'
  'Session'
  'BoundedStaleness'
  'Strong'
])
param cosmosDbConsistencyLevel string = 'Session'

@description('SKU name for Azure Cache for Redis.')
@allowed([
  'Basic'
  'Standard'
  'Premium'
])
param redisSkuName string = 'Standard'

@description('SKU family for Azure Cache for Redis (C for Basic/Standard, P for Premium).')
@allowed([
  'C'
  'P'
])
param redisSkuFamily string = 'C'

@description('SKU capacity/size for Azure Cache for Redis.')
param redisSkuCapacity int = 1

@description('SKU for the storage account.')
param storageSkuName string = 'Standard_LRS'

@description('Address space (CIDR) for the virtual network.')
param vnetAddressPrefix string = '10.20.0.0/16'

@description('Address prefix (CIDR) for the AKS node subnet.')
param aksSubnetPrefix string = '10.20.0.0/20'

@description('Address prefix (CIDR) for the private endpoints subnet.')
param privateEndpointSubnetPrefix string = '10.20.16.0/24'

@description('Kubernetes namespace of the service account that will use workload identity to access Azure resources.')
param workloadIdentityServiceAccountNamespace string = 'scope'

@description('Name of the Kubernetes service account that will use workload identity to access Azure resources.')
param workloadIdentityServiceAccountName string = 'scope-workload-identity'

// Deterministic, globally-unique-ish suffix for resources that require
// globally unique names (Key Vault, ACR, storage account, Cosmos DB, Redis).
var resourceToken = uniqueString(resourceGroup().id, environmentName)

var vnetName = 'vnet-${environmentName}-${resourceToken}'
var aksName = 'aks-${environmentName}-${resourceToken}'
var keyVaultName = take('kv-${environmentName}-${resourceToken}', 24)
var acrName = take(replace('acr${environmentName}${resourceToken}', '-', ''), 50)
var cosmosAccountName = take('cosmos-${environmentName}-${resourceToken}', 44)
var redisName = take('redis-${environmentName}-${resourceToken}', 63)
var storageAccountName = take(replace('st${environmentName}${resourceToken}', '-', ''), 24)
var workloadIdentityName = 'id-${environmentName}-${resourceToken}'

// Built-in role definition IDs used for cross-module role assignments.
var acrPullRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
var networkContributorRoleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4d97b98b-1d4f-4787-a291-c67834d212e7')

// ---------------------------------------------------------------------------
// Networking: VNet + AKS subnet + private endpoints subnet
// ---------------------------------------------------------------------------
module networking 'modules/networking.bicep' = {
  name: 'networking'
  params: {
    location: location
    tags: tags
    vnetName: vnetName
    vnetAddressPrefix: vnetAddressPrefix
    aksSubnetPrefix: aksSubnetPrefix
    privateEndpointSubnetPrefix: privateEndpointSubnetPrefix
  }
}

// ---------------------------------------------------------------------------
// Workload identity: the User Assigned Managed Identity that Scope's
// Kubernetes workloads (via their service account) federate with to access
// Key Vault, Storage, and other Azure resources without secrets.
// ---------------------------------------------------------------------------
module workloadIdentity 'br/public:avm/res/managed-identity/user-assigned-identity:0.4.0' = {
  name: 'workload-identity'
  params: {
    name: workloadIdentityName
    location: location
    tags: tags
    federatedIdentityCredentials: [
      {
        name: 'scope-workload-identity-federation'
        issuer: aks.outputs.oidcIssuerUrl
        subject: 'system:serviceaccount:${workloadIdentityServiceAccountNamespace}:${workloadIdentityServiceAccountName}'
        audiences: [
          'api://AzureADTokenExchange'
        ]
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// Key Vault: RBAC-authorized, private endpoint, workload identity granted
// read access to secrets.
// ---------------------------------------------------------------------------
module keyVault 'modules/keyvault.bicep' = {
  name: 'keyvault'
  params: {
    location: location
    tags: tags
    keyVaultName: keyVaultName
    vnetResourceId: networking.outputs.vnetResourceId
    privateEndpointSubnetResourceId: networking.outputs.privateEndpointSubnetResourceId
    workloadIdentityPrincipalId: workloadIdentity.outputs.principalId
  }
}

// ---------------------------------------------------------------------------
// Azure Container Registry: hosts the worker image (can't be hosted on
// GHCR for private workloads). Admin user disabled; AcrPull granted to the
// AKS kubelet identity below, once both resources exist.
// ---------------------------------------------------------------------------
module acr 'modules/acr.bicep' = {
  name: 'acr'
  params: {
    location: location
    tags: tags
    #disable-next-line BCP334 // acrName is derived from environmentName (minLength 3) + a 13-char uniqueString(); never empty.
    acrName: acrName
    skuName: acrSkuName
  }
}

// ---------------------------------------------------------------------------
// Cosmos DB (MongoDB API only), private endpoint.
// ---------------------------------------------------------------------------
module cosmosDb 'modules/cosmosdb.bicep' = {
  name: 'cosmosdb'
  params: {
    location: location
    tags: tags
    accountName: cosmosAccountName
    vnetResourceId: networking.outputs.vnetResourceId
    privateEndpointSubnetResourceId: networking.outputs.privateEndpointSubnetResourceId
    consistencyLevel: cosmosDbConsistencyLevel
  }
}

// ---------------------------------------------------------------------------
// Azure Cache for Redis, private endpoint, Entra ID auth preferred.
// ---------------------------------------------------------------------------
module redis 'modules/redis.bicep' = {
  name: 'redis'
  params: {
    location: location
    tags: tags
    redisName: redisName
    vnetResourceId: networking.outputs.vnetResourceId
    privateEndpointSubnetResourceId: networking.outputs.privateEndpointSubnetResourceId
    skuName: redisSkuName
    skuFamily: redisSkuFamily
    skuCapacity: redisSkuCapacity
  }
}

// ---------------------------------------------------------------------------
// Storage account (blob + queue only), private endpoints, workload identity
// granted data-plane RBAC access.
// ---------------------------------------------------------------------------
module storage 'modules/storage.bicep' = {
  name: 'storage'
  params: {
    location: location
    tags: tags
    #disable-next-line BCP334 // storageAccountName is derived from environmentName (minLength 3) + a 13-char uniqueString(); never empty.
    storageAccountName: storageAccountName
    vnetResourceId: networking.outputs.vnetResourceId
    privateEndpointSubnetResourceId: networking.outputs.privateEndpointSubnetResourceId
    skuName: storageSkuName
    workloadIdentityPrincipalId: workloadIdentity.outputs.principalId
  }
}

// ---------------------------------------------------------------------------
// AKS cluster: System + User node pools, Cilium network policy, OIDC issuer
// + workload identity enabled, native Key Vault Secrets Provider add-on.
// ---------------------------------------------------------------------------
module aks 'modules/aks.bicep' = {
  name: 'aks'
  params: {
    location: location
    tags: tags
    aksName: aksName
    kubernetesVersion: kubernetesVersion
    vnetSubnetResourceId: networking.outputs.aksSubnetResourceId
    systemNodeVmSize: aksSystemNodeVmSize
    systemNodeCount: aksSystemNodeCount
    userNodeVmSize: aksUserNodeVmSize
    userNodeCount: aksUserNodeCount
  }
}

// ---------------------------------------------------------------------------
// Cross-module role assignments (kept in the orchestrator to avoid circular
// module dependencies between ACR/AKS and VNet/AKS).
// ---------------------------------------------------------------------------

// Grant the AKS kubelet identity pull access to ACR, so nodes can pull the
// worker image hosted there.
resource acrPullRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, acrName, aksName, acrPullRoleDefinitionId)
  scope: resourceGroup()
  properties: {
    roleDefinitionId: acrPullRoleDefinitionId
    principalId: aks.outputs.kubeletIdentityObjectId
    principalType: 'ServicePrincipal'
  }
}

// Grant the AKS cluster's system-assigned identity Network Contributor on
// the resource group so it can manage the pre-created subnet it was given
// (required when using Azure CNI with a bring-your-own subnet).
resource aksNetworkContributorRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, vnetName, aksName, networkContributorRoleDefinitionId)
  scope: resourceGroup()
  properties: {
    roleDefinitionId: networkContributorRoleDefinitionId
    principalId: aks.outputs.aksSystemAssignedIdentityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// ---------------------------------------------------------------------------
// Key Vault secrets: populate generic (non-Scope-specific) secret names with
// the connection information for Cosmos DB and Redis, so the AKS Key Vault
// Secrets Provider add-on can sync them into the cluster as Kubernetes
// Secrets for the Helm-based app install to consume. Storage access is
// RBAC-only (no key secret needed) per the workload identity role
// assignments granted above.
// ---------------------------------------------------------------------------
resource existingKeyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
  dependsOn: [
    keyVault
  ]
}

resource cosmosConnectionStringSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: existingKeyVault
  name: 'cosmos-connection-string'
  properties: {
    value: cosmosDb.outputs.primaryConnectionString
  }
}

resource redisConnectionStringSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: existingKeyVault
  name: 'redis-primary-key'
  properties: {
    value: redis.outputs.primaryKey
  }
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

@description('Name of the resource group all resources were deployed into.')
output resourceGroupName string = resourceGroup().name

@description('Name of the AKS cluster. Use `az aks get-credentials --resource-group <rg> --name <this>` to connect.')
output aksClusterName string = aks.outputs.aksName

@description('Login server for the Azure Container Registry (e.g. for `docker push`).')
output acrLoginServer string = acr.outputs.acrLoginServer

@description('Name of the Key Vault holding BYO secrets and generated connection secrets.')
output keyVaultName string = keyVault.outputs.keyVaultName

@description('URI of the Key Vault.')
output keyVaultUri string = keyVault.outputs.keyVaultUri

@description('Document endpoint of the Cosmos DB account.')
output cosmosDbAccountEndpoint string = cosmosDb.outputs.accountEndpoint

@description('Hostname of the Azure Cache for Redis instance.')
output redisHostName string = redis.outputs.hostName

@description('Name of the storage account.')
output storageAccountName string = storage.outputs.storageAccountName

@description('Client ID of the workload identity. Annotate your Kubernetes service account (`azure.workload.identity/client-id`) with this value.')
output workloadIdentityClientId string = workloadIdentity.outputs.clientId

@description('Kubernetes namespace expected for the workload identity federated credential subject.')
output workloadIdentityServiceAccountNamespace string = workloadIdentityServiceAccountNamespace

@description('Kubernetes service account name expected for the workload identity federated credential subject.')
output workloadIdentityServiceAccountName string = workloadIdentityServiceAccountName
