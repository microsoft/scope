// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Run } from "@/types";

export interface ExistingRunMembershipEligibility {
  eligible: boolean;
  assignedCount: number;
  reason?: string;
}

export function getExistingRunMembershipEligibility(
  selectedIds: ReadonlySet<string>,
  loadedSelectedRuns: Run[],
): ExistingRunMembershipEligibility {
  if (selectedIds.size === 0) {
    return { eligible: false, assignedCount: 0, reason: "Select at least one run." };
  }
  if (loadedSelectedRuns.length !== selectedIds.size) {
    return {
      eligible: false,
      assignedCount: 0,
      reason: "Return to the page where every selected run is visible to verify eligibility.",
    };
  }
  const assignedCount = loadedSelectedRuns.filter((run) => Boolean(run.experimentId)).length;
  if (assignedCount > 0) {
    return {
      eligible: false,
      assignedCount,
      reason: `${assignedCount} selected run${assignedCount === 1 ? " is" : "s are"} already assigned to an Experiment.`,
    };
  }
  return { eligible: true, assignedCount: 0 };
}
