// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

@description('Azure region for all resources.')
param location string

@description('Tags to apply to all resources.')
param tags object = {}

@description('Name of the Key Vault. Must be globally unique.')
@minLength(3)
@maxLength(24)
param keyVaultName string

@description('Resource ID of the virtual network to link the private DNS zone to.')
param vnetResourceId string

@description('Resource ID of the subnet to deploy the Key Vault private endpoint into.')
param privateEndpointSubnetResourceId string

@description('Principal (object) ID of the workload identity to grant secrets read/write access to. Leave empty to skip the role assignment.')
param workloadIdentityPrincipalId string = ''

@description('Key Vault SKU name.')
@allowed([
  'standard'
  'premium'
])
param skuName string = 'standard'

@description('Number of days to retain soft-deleted vaults/objects.')
param softDeleteRetentionInDays int = 90

var keyVaultSecretsOfficerRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
)

module privateDnsZone 'br/public:avm/res/network/private-dns-zone:0.7.0' = {
  name: '${deployment().name}-kv-dns-zone'
  params: {
    name: 'privatelink.vaultcore.azure.net'
    tags: tags
    virtualNetworkLinks: [
      {
        virtualNetworkResourceId: vnetResourceId
      }
    ]
  }
}

module keyVault 'br/public:avm/res/key-vault/vault:0.11.0' = {
  name: '${deployment().name}-kv'
  params: {
    name: keyVaultName
    location: location
    tags: tags
    sku: skuName
    enableRbacAuthorization: true
    publicNetworkAccess: 'Disabled'
    enableSoftDelete: true
    softDeleteRetentionInDays: softDeleteRetentionInDays
    enablePurgeProtection: true
    privateEndpoints: [
      {
        service: 'vault'
        subnetResourceId: privateEndpointSubnetResourceId
        privateDnsZoneGroup: {
          privateDnsZoneGroupConfigs: [
            {
              privateDnsZoneResourceId: privateDnsZone.outputs.resourceId
            }
          ]
        }
      }
    ]
    roleAssignments: !empty(workloadIdentityPrincipalId)
      ? [
          {
            principalId: workloadIdentityPrincipalId
            // Secrets Officer (not just Secrets User/read-only) is required because the Token
            // Manager service (apps/token-manager) writes BYO credentials (e.g. GitHub/Anthropic
            // API keys) into this vault at runtime via SecretClient.setSecret(), using this same
            // shared workload identity - a read-only role 403s that write path.
            roleDefinitionIdOrName: keyVaultSecretsOfficerRoleDefinitionId
            principalType: 'ServicePrincipal'
          }
        ]
      : []
  }
}

@description('Resource ID of the Key Vault.')
output keyVaultResourceId string = keyVault.outputs.resourceId

@description('Name of the Key Vault.')
output keyVaultName string = keyVault.outputs.name

@description('URI of the Key Vault.')
output keyVaultUri string = keyVault.outputs.uri
