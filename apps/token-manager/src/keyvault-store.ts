// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { SecretClient } from "@azure/keyvault-secrets";
import { DefaultAzureCredential } from "@azure/identity";

/**
 * Abstraction over secret storage.
 * Implemented by KeyVaultSecretStore — backed by Azure Key Vault in production
 * and Lowkey Vault (emulator) in local Docker Compose.
 */
export interface SecretStore {
  getSecret(name: string, options?: { bypassCache?: boolean }): Promise<string>;
  setSecret(name: string, value: string): Promise<void>;
  deleteSecret(name: string): Promise<void>;
}

interface CacheEntry {
  value: string;
  fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Azure KeyVault-backed secret store with in-process caching.
 * Works with both Azure Key Vault (production) and Lowkey Vault (local dev).
 */
export class KeyVaultSecretStore implements SecretStore {
  private client: SecretClient;
  private cache: Map<string, CacheEntry> = new Map();
  private cacheTtlMs: number;

  constructor(vaultUri: string, cacheTtlMs: number = CACHE_TTL_MS) {
    this.client = new SecretClient(vaultUri, new DefaultAzureCredential(), {
      disableChallengeResourceVerification: true,
    });
    this.cacheTtlMs = cacheTtlMs;
  }

  async getSecret(name: string, options?: { bypassCache?: boolean }): Promise<string> {
    const cached = this.cache.get(name);
    if (!options?.bypassCache && cached && Date.now() - cached.fetchedAt < this.cacheTtlMs) {
      return cached.value;
    }

    const secret = await this.client.getSecret(name);
    if (!secret.value) {
      throw new Error(`Secret '${name}' has no value in KeyVault`);
    }

    this.cache.set(name, { value: secret.value, fetchedAt: Date.now() });
    return secret.value;
  }

  async setSecret(name: string, value: string): Promise<void> {
    await this.client.setSecret(name, value);
    this.cache.set(name, { value, fetchedAt: Date.now() });
  }

  async deleteSecret(name: string): Promise<void> {
    await this.client.beginDeleteSecret(name);
    this.cache.delete(name);
  }
}

/**
 * Creates a KeyVaultSecretStore for the given vault URI.
 * In production, this points to Azure Key Vault.
 * In local Docker Compose, this points to Lowkey Vault (emulator).
 */
export function createSecretStore(keyvaultUri: string): SecretStore {
  return new KeyVaultSecretStore(keyvaultUri);
}
