// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { isAgentAvailable } from "@/types";
import type { CodingAgent, RunFacetBucket } from "@/types";

const EMPTY_FILTER_VALUE = "__empty__";

export type RunWorkerFilterOption = {
  value: string;
  label: string;
  count: number;
};

export function buildRunWorkerFilterOptions(
  agents: CodingAgent[],
  buckets: RunFacetBucket[] | undefined,
): RunWorkerFilterOption[] {
  const counts = new Map((buckets ?? []).map((bucket) => [bucket.value, bucket.count]));
  const names = new Map(
    agents
      .map((agent) => [agent._id, agent.name]),
  );
  const historicalWorkerIds = (buckets ?? [])
    .filter((bucket) => bucket.value !== EMPTY_FILTER_VALUE && bucket.count > 0)
    .map((bucket) => bucket.value);
  const workerIds = new Set([
    ...agents.filter(isAgentAvailable).map((agent) => agent._id),
    ...historicalWorkerIds,
  ]);
  const options = [...workerIds].map((workerId) => ({
    value: workerId,
    label: names.get(workerId) ?? "Unknown agent",
    count: counts.get(workerId) ?? 0,
  }));
  const emptyCount = counts.get(EMPTY_FILTER_VALUE) ?? 0;

  options.sort((a, b) => a.label.localeCompare(b.label));
  if (emptyCount > 0) {
    options.push({
      value: EMPTY_FILTER_VALUE,
      label: "(Unknown)",
      count: emptyCount,
    });
  }
  return options;
}
