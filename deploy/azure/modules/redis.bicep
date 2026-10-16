// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// This module deploys Azure Managed Redis (Microsoft.Cache/redisEnterprise, the "Balanced_*" SKU
// family) using the AVM module `avm/res/cache/redis-enterprise:0.5.0`. Classic Azure Cache for
// Redis (Microsoft.Cache/redis) is being retired for new deployments, so Azure Managed Redis - the
// currently supported, generally available successor on the same redisEnterprise resource
// provider - is used instead.

@description('Azure region for all resources.')
param location string

@description('Tags to apply to all resources.')
param tags object = {}

@description('Name of the Azure Managed Redis instance. Must be globally unique.')
@minLength(1)
@maxLength(60)
param redisName string

@description('Resource ID of the virtual network to link the private DNS zone to.')
param vnetResourceId string

@description('Resource ID of the subnet to deploy the Redis private endpoint into.')
param privateEndpointSubnetResourceId string

@description('Azure Managed Redis SKU name (Balanced tier; see https://aka.ms/redis/overview for the full SKU catalog). Defaults to the smallest available size to minimize regional capacity/quota pressure - Azure Managed Redis allocation can fail with InsufficientCapacity independent of subscription quota in constrained regions, and the smallest SKU plus disabled HA (see highAvailability below) is the least likely combination to hit that.')
@allowed([
  'Balanced_B0'
  'Balanced_B1'
  'Balanced_B3'
  'Balanced_B5'
  'Balanced_B10'
])
param skuName string = 'Balanced_B0'

@description('Whether to enable data replication for high availability. Defaults to Disabled - this roughly halves the underlying node allocation needed, reducing the odds of regional InsufficientCapacity errors and quota pressure for a quickstart/dev deployment. Set to Enabled for production (HA is recommended outside of dev/test).')
@allowed([
  'Enabled'
  'Disabled'
])
param highAvailability string = 'Disabled'

@description('Principal (object) ID of the workload identity to grant Microsoft Entra ID (Azure AD) data-plane access to the default Redis database, via an access policy assignment. Leave empty to skip the assignment.')
param workloadIdentityPrincipalId string = ''

// Private DNS zone name used for Azure Managed Redis private endpoints. Despite both sharing the
// same underlying resource type (Microsoft.Cache/RedisEnterprise) and private-endpoint subresource
// (redisEnterprise), Azure Managed Redis (the "Balanced"/"ComputeOptimized"/etc. SKUs used here)
// publishes its hostname under privatelink.redis.azure.net - NOT
// privatelink.redisenterprise.cache.azure.net, which is the zone for the older "Redis Enterprise"
// product branding (Enterprise/EnterpriseFlash SKUs). Using the wrong zone leaves it with no
// matching record set, so DNS falls through to the public (and thus unreachable, since
// publicNetworkAccess is Disabled) address. See
// https://learn.microsoft.com/azure/private-link/private-endpoint-dns for the authoritative table.
var privateDnsZoneName = 'privatelink.redis.azure.net'

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

// Microsoft Entra ID (Azure AD) authentication is preferred over access keys, granted here via an
// access policy assignment to the shared workload identity. Access-key authentication is left
// enabled as a fallback/compatibility mechanism for clients that cannot yet use Entra ID auth; its
// primary key is still surfaced as a secure output.
module redis 'br/public:avm/res/cache/redis-enterprise:0.5.0' = {
  name: 'redis-${uniqueString(redisName)}'
  params: {
    name: redisName
    location: location
    tags: tags
    skuName: skuName
    publicNetworkAccess: 'Disabled'
    highAvailability: highAvailability
    database: {
      accessKeysAuthentication: 'Enabled'
      // NOTE: `name` is documented as optional on this type, but the AVM module's nested access
      // policy assignment deployment reads `.name` directly (not via `tryGet`), which throws
      // InvalidTemplate ("property 'name' doesn't exist") if the property is omitted entirely.
      // Always supply it explicitly to work around that.
      accessPolicyAssignments: !empty(workloadIdentityPrincipalId)
        ? [
            {
              name: 'workload-identity-access'
              userObjectId: workloadIdentityPrincipalId
            }
          ]
        : []
    }
    privateEndpoints: [
      {
        service: 'redisEnterprise'
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
  }
}

@description('The resource ID of the Azure Managed Redis instance.')
output redisResourceId string = redis.outputs.resourceId

@description('The name of the Azure Managed Redis instance.')
output redisName string = redis.outputs.name

@description('The hostname of the Azure Managed Redis instance.')
output hostName string = redis.outputs.hostName

@description('The TCP port of the default Redis database.')
output port int = redis.outputs.port

@description('The primary access key for the default Redis database. Entra ID authentication is preferred; this key is provided as a fallback for compatibility.')
@secure()
output primaryKey string = redis.outputs.primaryAccessKey!
