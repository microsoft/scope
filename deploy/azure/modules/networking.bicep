// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

targetScope = 'resourceGroup' // Explicit resource-group scope for this module

@description('Azure region for all resources.')
param location string

@description('Tags to apply to all resources.')
param tags object = {}

@description('Name of the virtual network.')
@minLength(2)
@maxLength(64)
param vnetName string

@description('Address space (CIDR) for the virtual network.')
param vnetAddressPrefix string = '10.20.0.0/16'

@description('Address prefix (CIDR) for the AKS node subnet.')
param aksSubnetPrefix string = '10.20.0.0/20'

@description('Address prefix (CIDR) for the private endpoints subnet.')
param privateEndpointSubnetPrefix string = '10.20.16.0/24'

@description('Name of the network security group for the AKS node subnet.')
@minLength(2)
@maxLength(80)
param aksNsgName string = 'nsg-${vnetName}-aks'

@description('Name of the network security group for the private endpoints subnet.')
@minLength(2)
@maxLength(80)
param privateEndpointNsgName string = 'nsg-${vnetName}-pe'

// Network Security Group for the AKS node subnet. Uses AVM default security rules
// (deny internet inbound) with no custom allow rules and no IP allowlisting.
module aksNsg 'br/public:avm/res/network/network-security-group:0.5.0' = {
  name: 'aks-nsg-deployment'
  params: {
    name: aksNsgName
    location: location
    tags: tags
  }
}

// Network Security Group for the private endpoints subnet. Uses AVM default
// security rules (deny internet inbound) with no custom allow rules.
module privateEndpointNsg 'br/public:avm/res/network/network-security-group:0.5.0' = {
  name: 'pe-nsg-deployment'
  params: {
    name: privateEndpointNsgName
    location: location
    tags: tags
  }
}

// Virtual network with an AKS node subnet and a private-endpoints subnet,
// each associated with its own Network Security Group.
module virtualNetwork 'br/public:avm/res/network/virtual-network:0.5.1' = {
  name: 'vnet-deployment'
  params: {
    name: vnetName
    location: location
    tags: tags
    addressPrefixes: [
      vnetAddressPrefix
    ]
    subnets: [
      {
        name: 'snet-aks'
        addressPrefix: aksSubnetPrefix
        networkSecurityGroupResourceId: aksNsg.outputs.resourceId
      }
      {
        name: 'snet-pe'
        addressPrefix: privateEndpointSubnetPrefix
        networkSecurityGroupResourceId: privateEndpointNsg.outputs.resourceId
      }
    ]
  }
}

@description('Resource ID of the virtual network.')
output vnetResourceId string = virtualNetwork.outputs.resourceId

@description('Name of the virtual network.')
output vnetName string = virtualNetwork.outputs.name

@description('Resource ID of the AKS node subnet.')
output aksSubnetResourceId string = virtualNetwork.outputs.subnetResourceIds[indexOf(virtualNetwork.outputs.subnetNames, 'snet-aks')]

@description('Resource ID of the private endpoints subnet.')
output privateEndpointSubnetResourceId string = virtualNetwork.outputs.subnetResourceIds[indexOf(virtualNetwork.outputs.subnetNames, 'snet-pe')]
