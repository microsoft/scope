// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// This module deploys a classic Azure Cache for Redis instance (Microsoft.Cache/redis)
// using the AVM module `avm/res/cache/redis:0.5.0`. It is the well-established, generally
// available option for v1 of this template.
//
// NOTE: Azure Managed Redis (Microsoft.Cache/redisEnterprise, AVM `avm/res/cache/redis-enterprise`)
// is a newer, more performant offering and could be a future upgrade path for this template.

@description('Azure region for all resources.')
param location string

@description('Tags to apply to all resources.')
param tags object = {}

@description('Name of the Azure Cache for Redis instance. Must be globally unique.')
@minLength(1)
@maxLength(63)
param redisName string

@description('Resource ID of the virtual network to link the private DNS zone to.')
param vnetResourceId string

@description('Resource ID of the subnet to deploy the Redis private endpoint into.')
param privateEndpointSubnetResourceId string

@description('Redis SKU name.')
@allowed([
  'Basic'
  'Standard'
  'Premium'
])
param skuName string = 'Standard'

@description('Redis SKU family (C for Basic/Standard, P for Premium). Informational only: the underlying AVM module derives the actual family from skuName automatically.')
@allowed([
  'C'
  'P'
])
#disable-next-line no-unused-params // Part of the required parameter contract; the AVM module derives family from skuName automatically.
param skuFamily string = 'C'

@description('Redis SKU capacity/size.')
param skuCapacity int = 1

// Private DNS zone name used for Azure Cache for Redis private endpoints.
var privateDnsZoneName = 'privatelink.redis.cache.windows.net'

module privateDnsZone 'br/public:avm/res/network/private-dns-zone:0.7.0' = {
  name: 'redis-private-dns-zone-${uniqueString(redisName)}'
  params: {
    name: privateDnsZoneName
    tags: tags
    virtualNetworkLinks: [
      {
        virtualNetworkResourceId: vnetResourceId
        registrationEnabled: false
      }
    ]
  }
}

// Microsoft Entra ID (Azure AD) authentication is preferred over access keys. This is enabled via
// the `aad-enabled` redisConfiguration entry, which allows clients to authenticate using Entra ID
// tokens instead of (or alongside) the shared access keys. Assigning Redis data-plane access
// policies to specific principals (e.g. via `az redis access-policy-assignment`) is outside the
// scope of this module and should be performed separately after deployment.
// The non-SSL port remains disabled, and the access key output is still populated via listKeys()
// as a fallback/compatibility mechanism for clients that cannot yet use Entra ID auth.
module redis 'br/public:avm/res/cache/redis:0.5.0' = {
  name: 'redis-${uniqueString(redisName)}'
  params: {
    name: redisName
    location: location
    tags: tags
    skuName: skuName
    capacity: skuCapacity
    enableNonSslPort: false
    minimumTlsVersion: '1.2'
    publicNetworkAccess: 'Disabled'
    redisConfiguration: {
      'aad-enabled': 'true'
    }
    privateEndpoints: [
      {
        service: 'redisCache'
        subnetResourceId: privateEndpointSubnetResourceId
        privateDnsZoneResourceIds: [
          privateDnsZone.outputs.resourceId
        ]
      }
    ]
  }
}

@description('The resource ID of the Azure Cache for Redis instance.')
output redisResourceId string = redis.outputs.resourceId

@description('The name of the Azure Cache for Redis instance.')
output redisName string = redis.outputs.name

@description('The hostname of the Azure Cache for Redis instance.')
output hostName string = redis.outputs.hostName

@description('The primary access key for the Azure Cache for Redis instance. Entra ID authentication is preferred; this key is provided as a fallback for compatibility.')
@secure()
output primaryKey string = listKeys(resourceId('Microsoft.Cache/redis', redisName), '2024-03-01').primaryKey
