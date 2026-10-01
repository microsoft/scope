// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { stripTrailingSlashes } from "shared/strings";
import type { ModelSyncRequest, ReconcileReport, ScanResult } from "./types.js";

/**
 * Send scanned models to the API for lifecycle reconciliation.
 *
 * Calls POST /api/v1/models/sync which:
 * - Inserts new models with firstSeenAt = now
 * - Updates lastSeenAt for models still present
 * - Sets disappearedAt for models no longer in the scan
 * - Updates the agent's supportedModels array
 *
 * @returns A ReconcileReport describing what changed.
 */
export async function reconcileModels(
  apiUrl: string,
  agentId: string,
  provider: string,
  scanResult: ScanResult,
): Promise<ReconcileReport> {
  const url = `${stripTrailingSlashes(apiUrl)}/api/v1/models/sync`;

  const body: ModelSyncRequest = {
    agentId,
    provider,
    models: scanResult.models.map((m) => ({
      id: m.id,
      ...(m.providerAvailableFrom
        ? { providerAvailableFrom: m.providerAvailableFrom }
        : {}),
      ...(m.providerEndOfLife
        ? { providerEndOfLife: m.providerEndOfLife }
        : {}),
      ...(m.metadata ? { metadata: m.metadata } : {}),
      ...(m.capabilities ? { capabilities: m.capabilities } : {}),
    })),
    scannedAt: scanResult.scannedAt.toISOString(),
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "unknown error");
    throw new Error(
      `Model sync failed (HTTP ${response.status}): ${errorBody}`,
    );
  }

  return (await response.json()) as ReconcileReport;
}
