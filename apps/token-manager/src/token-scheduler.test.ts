// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startTokenScheduler, TokenSchedulerDeps } from "./token-scheduler.js";
import { KeyDocument } from "@scope/secrets";

function makeToken(overrides: Partial<KeyDocument> = {}): KeyDocument {
  return {
    _id: "test-id-1",
    type: "github-pat-classic",
    capabilities: ["copilot-sdk", "copilot-cli"],
    secretName: "token-github-pat-classic-test-id-",
    enabled: true,
    lastValidationStatus: "unknown",
    createdAt: new Date(),
    ...overrides,
  };
}

describe("TokenScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createMockDeps(tokens: KeyDocument[] = []): TokenSchedulerDeps & {
    mockCollection: any;
    mockGetSecret: ReturnType<typeof vi.fn>;
    mockValidate: ReturnType<typeof vi.fn>;
  } {
    const mockCollection = {
      find: vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue(tokens),
      }),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    };

    const mockGetSecret = vi.fn().mockResolvedValue("secret-value");
    const mockValidate = vi.fn().mockResolvedValue({ status: "valid" });

    return {
      collection: mockCollection as any,
      getSecretValue: mockGetSecret,
      validateToken: mockValidate,
      intervalMs: 10_000, // 10s for testing
      mockCollection,
      mockGetSecret,
      mockValidate,
    };
  }

  it("validates all active tokens on tick", async () => {
    const tokens = [
      makeToken({ _id: "id-1", secretName: "token-github-pat-classic-id-1" }),
      makeToken({ _id: "id-2", secretName: "token-github-pat-classic-id-2" }),
      makeToken({ _id: "id-3", secretName: "token-github-pat-classic-id-3" }),
    ];

    const deps = createMockDeps(tokens);
    const scheduler = startTokenScheduler(deps);

    // Wait for initial tick (runs immediately)
    await vi.advanceTimersByTimeAsync(0);

    expect(deps.mockGetSecret).toHaveBeenCalledTimes(3);
    expect(deps.mockValidate).toHaveBeenCalledTimes(3);
    expect(deps.mockCollection.updateOne).toHaveBeenCalledTimes(3);

    scheduler.stop();
  });

  it("queries only enabled non-deleted tokens", async () => {
    const deps = createMockDeps([]);
    const scheduler = startTokenScheduler(deps);

    await vi.advanceTimersByTimeAsync(0);

    expect(deps.mockCollection.find).toHaveBeenCalledWith({
      enabled: true,
      deletedAt: { $exists: false },
    });

    scheduler.stop();
  });

  it("updates MongoDB with validation result", async () => {
    const token = makeToken({ _id: "id-1" });
    const deps = createMockDeps([token]);
    deps.mockValidate.mockResolvedValue({
      status: "invalid",
      error: "Token expired",
    });

    const scheduler = startTokenScheduler(deps);
    await vi.advanceTimersByTimeAsync(0);

    expect(deps.mockCollection.updateOne).toHaveBeenCalledWith(
      { _id: "id-1" },
      {
        $set: expect.objectContaining({
          lastValidationStatus: "invalid",
          lastValidationError: "Token expired",
        }),
      }
    );

    scheduler.stop();
  });

  it("continues validating other tokens when one fails", async () => {
    const tokens = [
      makeToken({ _id: "id-1", secretName: "token-github-pat-classic-id-1" }),
      makeToken({ _id: "id-2", secretName: "token-github-pat-classic-id-2" }),
    ];

    const deps = createMockDeps(tokens);
    deps.mockGetSecret
      .mockResolvedValueOnce("value-1") // id-1 succeeds
      .mockRejectedValueOnce(new Error("KeyVault error")); // id-2 fails

    // Suppress expected error log
    vi.spyOn(console, "error").mockImplementation(() => {});

    const scheduler = startTokenScheduler(deps);
    await vi.advanceTimersByTimeAsync(0);

    // First token validated normally
    expect(deps.mockValidate).toHaveBeenCalledTimes(1);
    // Both tokens got updateOne calls (success + error)
    expect(deps.mockCollection.updateOne).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it("runs on interval", async () => {
    const deps = createMockDeps([makeToken()]);
    const scheduler = startTokenScheduler(deps);

    // Initial tick
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.mockValidate).toHaveBeenCalledTimes(1);

    // After one interval
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deps.mockValidate).toHaveBeenCalledTimes(2);

    // After another interval
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deps.mockValidate).toHaveBeenCalledTimes(3);

    scheduler.stop();
  });

  it("stops the interval", async () => {
    const deps = createMockDeps([makeToken()]);

    // Suppress stop log
    vi.spyOn(console, "log").mockImplementation(() => {});

    const scheduler = startTokenScheduler(deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.mockValidate).toHaveBeenCalledTimes(1);

    scheduler.stop();

    // No more ticks after stop
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deps.mockValidate).toHaveBeenCalledTimes(1);
  });

  it("logs warning for soon-to-expire tokens", async () => {
    const threeDaysFromNow = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const token = makeToken({ _id: "id-exp", expiresAt: threeDaysFromNow });

    const deps = createMockDeps([token]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const scheduler = startTokenScheduler(deps);
    await vi.advanceTimersByTimeAsync(0);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/expires in 3 day/)
    );

    scheduler.stop();
  });

  it("does nothing when no active tokens exist", async () => {
    const deps = createMockDeps([]);
    const scheduler = startTokenScheduler(deps);
    await vi.advanceTimersByTimeAsync(0);

    expect(deps.mockGetSecret).not.toHaveBeenCalled();
    expect(deps.mockValidate).not.toHaveBeenCalled();

    scheduler.stop();
  });
});
