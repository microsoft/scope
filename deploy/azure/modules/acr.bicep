// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

@description('Azure region for all resources.')
param location string

@description('Tags to apply to all resources.')
param tags object = {}

@description('Name of the Azure Container Registry. Must be globally unique, alphanumeric only.')
@minLength(5)
@maxLength(50)
param acrName string

@description('SKU for the container registry.')
@allowed([
  'Basic'
  'Standard'
  'Premium'
])
param skuName string = 'Standard'

// AcrPull role assignment to the AKS kubelet identity is granted by the
// orchestrating main.bicep to avoid a circular dependency between the ACR
// and AKS modules.
module registry 'br/public:avm/res/container-registry/registry:0.6.0' = {
  name: 'acr-deployment'
  params: {
    name: acrName
    location: location
    tags: tags
    acrSku: skuName
    acrAdminUserEnabled: false
  }
}

output acrResourceId string = registry.outputs.resourceId
output acrName string = registry.outputs.name
output acrLoginServer string = registry.outputs.loginServer
