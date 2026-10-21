// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Model } from "@/types";

export type ModelProviderFilterOption = {
  value: string;
  label: string;
  count: number;
};

export function buildModelProviderFilterOptions(
  models: readonly Pick<Model, "provider">[],
): ModelProviderFilterOption[] {
  const counts = new Map<string, number>();
  for (const model of models) {
    counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([value, count]) => ({ value, label: value, count }));
}
