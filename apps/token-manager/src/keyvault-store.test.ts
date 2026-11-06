// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { KeyVaultSecretStore } from "./keyvault-store.js";

describe("KeyVaultSecretStore caching", () => {
  it("returns cached value within TTL", async () => {
    // We can't easily test the real SecretClient, so we test the caching logic
    // by using a short TTL and mocking time
    vi.useFakeTimers();

    const mockSecretClient = {
      getSecret: vi.fn().mockResolvedValue({ value: "secret-value" }),
      setSecret: vi.fn().mockResolvedValue({}),
      beginDeleteSecret: vi.fn().mockResolvedValue({}),
    };

    // Create store with a mocked client via prototype manipulation
    const store = new KeyVaultSecretStore("https://fake-vault.vault.azure.net", 60_000);
    // Replace internal client with mock
    (store as any).client = mockSecretClient;

    // First call — hits the client
    const val1 = await store.getSecret("test-secret");
    expect(val1).toBe("secret-value");
    expect(mockSecretClient.getSecret).toHaveBeenCalledTimes(1);

    // Second call within TTL — returns cached
    vi.advanceTimersByTime(30_000); // 30s < 60s TTL
    const val2 = await store.getSecret("test-secret");
    expect(val2).toBe("secret-value");
    expect(mockSecretClient.getSecret).toHaveBeenCalledTimes(1); // Still 1

    // Third call after TTL — re-fetches
    vi.advanceTimersByTime(31_000); // 30+31 = 61s > 60s TTL
    const val3 = await store.getSecret("test-secret");
    expect(val3).toBe("secret-value");
    expect(mockSecretClient.getSecret).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it("caches value after setSecret", async () => {
    const mockSecretClient = {
      getSecret: vi.fn().mockResolvedValue({ value: "old-value" }),
      setSecret: vi.fn().mockResolvedValue({}),
      beginDeleteSecret: vi.fn().mockResolvedValue({}),
    };

    const store = new KeyVaultSecretStore("https://fake-vault.vault.azure.net");
    (store as any).client = mockSecretClient;

    await store.setSecret("test-secret", "new-value");
    const val = await store.getSecret("test-secret");

    expect(val).toBe("new-value");
    expect(mockSecretClient.getSecret).not.toHaveBeenCalled(); // Served from cache
    expect(mockSecretClient.setSecret).toHaveBeenCalledWith("test-secret", "new-value");
  });

  it("clears cache on deleteSecret", async () => {
    const mockSecretClient = {
      getSecret: vi.fn().mockResolvedValue({ value: "value" }),
      setSecret: vi.fn().mockResolvedValue({}),
      beginDeleteSecret: vi.fn().mockResolvedValue({}),
    };

    const store = new KeyVaultSecretStore("https://fake-vault.vault.azure.net");
    (store as any).client = mockSecretClient;

    // Prime cache
    await store.getSecret("test-secret");
    expect(mockSecretClient.getSecret).toHaveBeenCalledTimes(1);

    // Delete clears cache
    await store.deleteSecret("test-secret");

    // Next get must re-fetch
    await store.getSecret("test-secret");
    expect(mockSecretClient.getSecret).toHaveBeenCalledTimes(2);
  });

  it("bypasses a cached write when validation needs the stored credential", async () => {
    const mockSecretClient = {
      getSecret: vi.fn().mockResolvedValue({ value: "concurrent-value" }),
      setSecret: vi.fn().mockResolvedValue({}),
    };
    const store = new KeyVaultSecretStore("https://fake-vault.vault.azure.net");
    (store as any).client = mockSecretClient;
    await store.setSecret("test-secret", "captured-value");
    expect(await store.getSecret("test-secret", { bypassCache: true })).toBe("concurrent-value");
    expect(mockSecretClient.getSecret).toHaveBeenCalledWith("test-secret");
    expect(await store.getSecret("test-secret")).toBe("concurrent-value");
    expect(mockSecretClient.getSecret).toHaveBeenCalledTimes(1);
  });

});
