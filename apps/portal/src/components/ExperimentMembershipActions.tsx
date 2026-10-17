// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { FlaskConical, MoveRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ExistingRunMembershipEligibility } from "@/lib/experiment-membership";

export interface ExperimentMembershipActionsProps {
  eligibility: ExistingRunMembershipEligibility;
  selectedCount: number;
  busy?: boolean;
  onCreate: () => void;
  onMove: () => void;
}

export function ExperimentMembershipActions({
  eligibility,
  selectedCount,
  busy = false,
  onCreate,
  onMove,
}: ExperimentMembershipActionsProps) {
  const disabled = busy || !eligibility.eligible;
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        disabled={disabled}
        onClick={onCreate}
        title={
          eligibility.reason ??
          "Create an Experiment from selected standalone runs"
        }
      >
        <FlaskConical className="h-3.5 w-3.5" /> Create experiment
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        disabled={disabled}
        onClick={onMove}
        title={
          eligibility.reason ??
          "Move selected standalone runs to an Experiment"
        }
      >
        <MoveRight className="h-3.5 w-3.5" /> Move to experiment
      </Button>
      {!eligibility.eligible && eligibility.reason && selectedCount > 0 && (
        <span className="max-w-64 text-xs text-muted-foreground">
          {eligibility.reason}
        </span>
      )}
    </>
  );
}
