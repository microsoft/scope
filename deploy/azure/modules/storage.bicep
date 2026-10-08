// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

@description('Azure region for all resources.')
param location string

@description('Tags to apply to all resources.')
param tags object = {}

@description('Name of the storage account. Must be globally unique, lowercase alphanumeric only.')
@minLength(3)
@maxLength(24)
param storageAccountName string

@description('Resource ID of the virtual network to link the private DNS zones to.')
param vnetResourceId string

@description('Resource ID of the subnet to deploy the storage private endpoints into.')
param privateEndpointSubnetResourceId string

@description('Storage account SKU.')
param skuName string = 'Standard_LRS'

@description('Principal (object) ID of the workload identity to grant blob/queue data-plane access. Leave empty to skip the role assignments.')
param workloadIdentityPrincipalId string = ''

// This storage account is used for blob and queue workloads only (no file shares, no tables).
// NOTE on shared-key access: the AVM module exposes `allowSharedKeyAccess` and cleanly supports
// disabling it alongside RBAC-based access (`defaultToOAuthAuthentication: true`), so we disable
// shared-key access entirely here and rely exclusively on Microsoft Entra ID (RBAC) role
// assignments for data-plane access.
#disable-next-line no-hardcoded-env-urls // Azure Public Cloud zone name; see AVM private-dns-zone module docs for multi-cloud variants.
var blobPrivateDnsZoneName = 'privatelink.blob.core.windows.net'
#disable-next-line no-hardcoded-env-urls // Azure Public Cloud zone name; see AVM private-dns-zone module docs for multi-cloud variants.
var queuePrivateDnsZoneName = 'privatelink.queue.core.windows.net'

var workloadIdentityRoleAssignments = !empty(workloadIdentityPrincipalId)
  ? [
      {
        roleDefinitionIdOrName: 'Storage Blob Data Contributor'
        principalId: workloadIdentityPrincipalId
        principalType: 'ServicePrincipal'
      }
      {
        roleDefinitionIdOrName: 'Storage Queue Data Contributor'
        principalId: workloadIdentityPrincipalId
        principalType: 'ServicePrincipal'
      }
    ]
  : []

module blobPrivateDnsZone 'br/public:avm/res/network/private-dns-zone:0.7.0' = {
  name: 'blob-private-dns-zone'
  params: {
    name: blobPrivateDnsZoneName
    tags: tags
    virtualNetworkLinks: [
      {
        virtualNetworkResourceId: vnetResourceId
        registrationEnabled: false
      }
    ]
  }
}

module queuePrivateDnsZone 'br/public:avm/res/network/private-dns-zone:0.7.0' = {
  name: 'queue-private-dns-zone'
  params: {
    name: queuePrivateDnsZoneName
    tags: tags
    virtualNetworkLinks: [
      {
        virtualNetworkResourceId: vnetResourceId
        registrationEnabled: false
      }
    ]
  }
}

module storageAccount 'br/public:avm/res/storage/storage-account:0.14.0' = {
  name: 'storage-account'
  params: {
    name: storageAccountName
    location: location
    tags: tags
    kind: 'StorageV2'
    skuName: skuName
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    publicNetworkAccess: 'Disabled'
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
    }
    privateEndpoints: [
      {
        service: 'blob'
        subnetResourceId: privateEndpointSubnetResourceId
        privateDnsZoneGroup: {
          privateDnsZoneGroupConfigs: [
            {
              privateDnsZoneResourceId: blobPrivateDnsZone.outputs.resourceId
            }
          ]
        }
      }
      {
        service: 'queue'
        subnetResourceId: privateEndpointSubnetResourceId
        privateDnsZoneGroup: {
          privateDnsZoneGroupConfigs: [
            {
              privateDnsZoneResourceId: queuePrivateDnsZone.outputs.resourceId
            }
          ]
        }
      }
    ]
    roleAssignments: workloadIdentityRoleAssignments
  }
}

@description('Resource ID of the storage account.')
output storageAccountResourceId string = storageAccount.outputs.resourceId

@description('Name of the storage account.')
output storageAccountName string = storageAccount.outputs.name

@description('Blob service endpoint of the storage account.')
output blobEndpoint string = storageAccount.outputs.serviceEndpoints.blob

@description('Queue service endpoint of the storage account.')
output queueEndpoint string = storageAccount.outputs.serviceEndpoints.queue
