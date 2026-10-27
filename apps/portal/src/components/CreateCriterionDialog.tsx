// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useCriteriaWizard } from "@/hooks/useCriteriaWizard";
import { CriteriaWizardStep1 } from "@/components/CriteriaWizardStep1";
import { CriteriaWizardStep2 } from "@/components/CriteriaWizardStep2";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ArrowLeft, Loader2, Sparkles } from "lucide-react";
import type { GateId } from "@/lib/gates";
import type { CriterionKind } from "@/types";

interface CreateCriterionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the new criterion ID after successful creation */
  onCreated: (id: string) => void;
  /** Pre-populated gate compatibility for the new criterion (defaults to ["select"]) */
  defaultGates?: GateId[];
  /** Gates that cannot be unselected (e.g. the gate this criterion is created for) */
  lockedGates?: GateId[];
  /** Pre-populated criteria kind (defaults to gate) */
  defaultKind?: CriterionKind;
  /** Specialized creation experience for inline observation entry points. */
  mode?: "criteria" | "observation";
}

export function CreateCriterionDialog({
  open,
  onOpenChange,
  onCreated,
  defaultGates,
  lockedGates,
  defaultKind,
  mode = "criteria",
}: CreateCriterionDialogProps) {
  const observationMode = mode === "observation";
  const wizard = useCriteriaWizard({
    initialGates: defaultGates,
    lockedGates,
    initialKind: observationMode ? "observation" : defaultKind,
    entityLabel: observationMode ? "Observation" : "Criterion",
    onSuccess: (id) => {
      onCreated(id);
      handleOpenChange(false);
    },
  });

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) wizard.reset();
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-w-2xl max-h-[90vh] overflow-y-auto"
        onPointerDownOutside={(e) => {
          // Prevent dialog dismiss when clicking on CriteriaPicker portal dropdowns
          if ((e.target as HTMLElement).closest?.("[data-criteria-picker-portal]")) {
            e.preventDefault();
          }
        }}
        onInteractOutside={(e) => {
          if ((e.target as HTMLElement).closest?.("[data-criteria-picker-portal]")) {
            e.preventDefault();
          }
        }}
      >
        {wizard.step === 1 ? (
          <>
            <DialogHeader>
              <DialogTitle>{observationMode ? "New Observation" : "New Criteria"}</DialogTitle>
              <DialogDescription>
                {observationMode
                  ? "Describe the behavior to observe"
                  : "Describe the behavior to evaluate"}
              </DialogDescription>
            </DialogHeader>

            <div className="py-2">
              <CriteriaWizardStep1
                wizard={wizard}
                idPrefix="dialog-"
                observationMode={observationMode}
              />
            </div>

            <DialogFooter>
              <Button
                data-command-enter
                onClick={wizard.handleContinue}
                disabled={!wizard.canContinue}
                className="gap-1.5"
              >
                Continue
                <Sparkles className="h-4 w-4" />
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>
                {observationMode ? "Review & Create Observation" : "Review & Create"}
              </DialogTitle>
              <DialogDescription>
                {wizard.behavior}
              </DialogDescription>
            </DialogHeader>

            <div className="py-2">
              <CriteriaWizardStep2 wizard={wizard} observationMode={observationMode} />
            </div>

            <DialogFooter className="flex-row justify-between sm:justify-between">
              <Button
                variant="ghost"
                onClick={() => wizard.setStep(1)}
                className="gap-1.5"
              >
                <ArrowLeft className="h-4 w-4" />
                Back
              </Button>
              <Button
                data-command-enter
                onClick={wizard.handleCreate}
                disabled={!wizard.prompt.trim() || wizard.createMutation.isPending}
                className="gap-1.5"
              >
                {wizard.createMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                {observationMode ? "Create Observation" : "Create"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
