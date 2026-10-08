// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Provisions an Azure Cosmos DB account (MongoDB API only) with public network
// access disabled and a private endpoint into the supplied subnet, backed by a
// dedicated Private DNS zone linked to the supplied virtual network.
//
// NOTE on throughput: this module uses the `EnableServerless` capability
// (serverless consumption-based billing) rather than provisioned RU/s. This
// keeps the quickstart "Deploy to Azure" footprint minimal/cheap by default,
// since there is no baseline RU/s cost when the account is idle. Switch to
// provisioned throughput (remove `EnableServerless` from `capabilitiesToAdd`
// and set throughput on your databases/collections) if you need guaranteed
// throughput or need features unsupported in serverless mode.

@description('Azure region for all resources.')
param location string

@description('Tags to apply to all resources.')
param tags object = {}

@description('Name of the Cosmos DB account. Must be globally unique.')
@minLength(3)
@maxLength(44)
param accountName string

@description('Resource ID of the virtual network to link the private DNS zone to.')
param vnetResourceId string

@description('Resource ID of the subnet to deploy the Cosmos DB private endpoint into.')
param privateEndpointSubnetResourceId string

@description('Name of the default MongoDB database created on the account.')
param databaseName string = 'scope'

@description('Default consistency level for the account.')
@allowed([
  'Eventual'
  'ConsistentPrefix'
  'Session'
  'BoundedStaleness'
  'Strong'
])
param consistencyLevel string = 'Session'

@description('Private DNS zone name used for the Cosmos DB MongoDB API private endpoint.')
var mongoPrivateDnsZoneName = 'privatelink.mongo.cosmos.azure.net'

module mongoPrivateDnsZone 'br/public:avm/res/network/private-dns-zone:0.7.0' = {
  name: '${deployment().name}-mongo-dns-zone'
  params: {
    name: mongoPrivateDnsZoneName
    tags: tags
    virtualNetworkLinks: [
      {
        virtualNetworkResourceId: vnetResourceId
        registrationEnabled: false
      }
    ]
  }
}

module cosmosDbAccount 'br/public:avm/res/document-db/database-account:0.10.0' = {
  name: '${deployment().name}-cosmosdb-account'
  params: {
    name: accountName
    location: location
    tags: tags
    // MongoDB API only — do not add SQL/Gremlin/Cassandra/Table capabilities.
    // Serverless keeps the quickstart footprint minimal/cheap by default; see
    // the note at the top of this file for how to switch to provisioned RU/s.
    capabilitiesToAdd: [
      'EnableMongo'
      'EnableServerless'
    ]
    defaultConsistencyLevel: consistencyLevel
    // The AVM module derives the account's `kind` (GlobalDocumentDB vs
    // MongoDB) from whether mongodbDatabases is non-empty — an empty array
    // leaves the account at kind=GlobalDocumentDB (SQL API) even with
    // EnableMongo in capabilitiesToAdd, which then rejects a MongoDB-groupId
    // private endpoint ("GroupId MongoDB is not supported"). At least one
    // database is required to get kind=MongoDB.
    mongodbDatabases: [
      {
        name: databaseName
      }
    ]
    networkRestrictions: {
      ipRules: []
      virtualNetworkRules: []
      publicNetworkAccess: 'Disabled'
    }
    privateEndpoints: [
      {
        service: 'MongoDB'
        subnetResourceId: privateEndpointSubnetResourceId
        privateDnsZoneGroup: {
          privateDnsZoneGroupConfigs: [
            {
              privateDnsZoneResourceId: mongoPrivateDnsZone.outputs.resourceId
            }
          ]
        }
      }
    ]
  }
}

// AVM's database-account module does not surface the account's connection
// strings, so pull them directly from the underlying resource.
resource existingCosmosDbAccount 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' existing = {
  name: accountName
  dependsOn: [
    cosmosDbAccount
  ]
}

@description('Resource ID of the Cosmos DB account.')
output accountResourceId string = cosmosDbAccount.outputs.resourceId

@description('Name of the Cosmos DB account.')
output accountName string = cosmosDbAccount.outputs.name

@description('Document endpoint of the Cosmos DB account.')
output accountEndpoint string = cosmosDbAccount.outputs.endpoint

@description('Primary connection string for the Cosmos DB account.')
@secure()
output primaryConnectionString string = existingCosmosDbAccount.listConnectionStrings().connectionStrings[0].connectionString
