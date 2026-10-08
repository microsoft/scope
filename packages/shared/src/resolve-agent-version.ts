// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { AgentVersion } from './types/types.js';

export interface ResolvedVersion {
  agentVersion: string;
  queueName?: string;
}

/**
 * Resolve which agent version to use for a run submission.
 *
 * - If `requestedVersion` is provided, find it in the active versions list.
 * - Otherwise, auto-select the latest active version by `createdAt` descending.
 *
 * Returns `{ agentVersion, queueName }` on success, or an error string.
 */
export function resolveAgentVersion(
  versions: AgentVersion[] | undefined,
  requestedVersion: string | undefined,
): ResolvedVersion | { error: string; activeVersions: string[] } {
  const activeVersions = (versions ?? []).filter((v) => v.status === "active");

  if (requestedVersion) {
    const match = activeVersions.find((v) => v.agentVersion === requestedVersion);
    if (!match) {
      return {
        error: `Agent version "${requestedVersion}" not found or not active`,
        activeVersions: activeVersions.map((v) => v.agentVersion),
      };
    }
    return { agentVersion: match.agentVersion, queueName: match.queueName };
  }

  if (activeVersions.length === 0) {
    return { error: "No active versions available", activeVersions: [] };
  }

  // Prefer routable versions for implicit selection. If every active version is
  // unroutable, retain the newest one so the caller can report a queue-specific
  // error rather than incorrectly claiming there are no active versions.
  const routableVersions = activeVersions.filter(
    (version) => (version.queueName?.trim().length ?? 0) > 0,
  );
  const sorted = [
    ...(routableVersions.length > 0 ? routableVersions : activeVersions),
  ].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  return { agentVersion: sorted[0].agentVersion, queueName: sorted[0].queueName };
}
