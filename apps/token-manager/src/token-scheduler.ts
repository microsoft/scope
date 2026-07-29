// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Collection } from "mongodb";
import { KeyDocument } from "@scope/secrets";
import { KeyType, KeyValidationResult } from "@scope/secrets";

export interface TokenSchedulerDeps {
  collection: Collection<KeyDocument>;
  getSecretValue: (name: string) => Promise<string>;
  validateToken: (type: KeyType, value: string) => Promise<KeyValidationResult>;
  intervalMs?: number;
}

export interface TokenSchedulerHandle {
  stop: () => void;
}

const EXPIRATION_WARNING_DAYS = 7;

/**
 * Starts a periodic scheduler that validates all active tokens.
 * Each tick:
 *   1. Queries active tokens (enabled, not deleted)
 *   2. Reads secret value from store
 *   3. Validates against provider API
 *   4. Updates MongoDB with validation result
 *   5. Logs warnings for expiring tokens
 */
export function startTokenScheduler(
  deps: TokenSchedulerDeps
): TokenSchedulerHandle {
  const intervalMs = deps.intervalMs ?? 300_000; // 5 minutes default

  const runValidation = async () => {
    try {
      const tokens = await deps.collection
        .find({ enabled: true, deletedAt: { $exists: false } })
        .toArray();

      if (tokens.length === 0) {
        return;
      }

      console.log(
        `[token-scheduler] Validating ${tokens.length} active token(s)...`
      );

      for (const token of tokens) {
        try {
          const value = await deps.getSecretValue(token.secretName);
          const result = await deps.validateToken(token.type, value);

          await deps.collection.updateOne(
            { _id: token._id },
            {
              $set: {
                lastValidatedAt: new Date(),
                lastValidationStatus: result.status,
                lastValidationError: result.error ?? undefined,
                capabilities: result.capabilities ?? [],
                updatedAt: new Date(),
              },
            }
          );

          if (result.status !== "valid") {
            console.warn(
              `[token-scheduler] Token ${token._id} (${token.type}): validation status = ${result.status}${result.error ? ` — ${result.error}` : ""}`
            );
          }

          // Check expiration
          if (token.expiresAt) {
            const daysUntilExpiry =
              (new Date(token.expiresAt).getTime() - Date.now()) /
              (1000 * 60 * 60 * 24);
            if (daysUntilExpiry <= EXPIRATION_WARNING_DAYS) {
              console.warn(
                `[token-scheduler] Token ${token._id} (${token.type}) expires in ${Math.round(daysUntilExpiry)} day(s)`
              );
            }
          }
        } catch (err) {
          console.error(
            `[token-scheduler] Failed to validate token ${token._id} (${token.type}):`,
            err instanceof Error ? err.message : err
          );

          // Update with error status so it doesn't block other tokens
          await deps.collection.updateOne(
            { _id: token._id },
            {
              $set: {
                lastValidatedAt: new Date(),
                lastValidationStatus: "error" as const,
                lastValidationError:
                  err instanceof Error ? err.message : String(err),
                updatedAt: new Date(),
              },
            }
          ).catch(() => {}); // Best-effort update
        }
      }
    } catch (err) {
      console.error(
        "[token-scheduler] Validation tick failed:",
        err instanceof Error ? err.message : err
      );
    }
  };

  // Run once immediately, then on interval
  runValidation();
  const intervalId = setInterval(runValidation, intervalMs);

  return {
    stop: () => {
      clearInterval(intervalId);
      console.log("[token-scheduler] Stopped");
    },
  };
}
