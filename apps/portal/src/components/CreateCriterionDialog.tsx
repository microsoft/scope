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
}

export function CreateCriterionDialog({ open, onOpenChange, onCreated, defaultGates, lockedGates, defaultKind }: CreateCriterionDialogProps) {
  const wizard = useCriteriaWizard({
    initialGates: defaultGates,
    lockedGates,
    initialKind: defaultKind,
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
              <DialogTitle>New Criteria</DialogTitle>
              <DialogDescription>
                Describe the behavior to evaluate
              </DialogDescription>
            </DialogHeader>

            <div className="py-2">
              <CriteriaWizardStep1 wizard={wizard} idPrefix="dialog-" />
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
              <DialogTitle>Review & Create</DialogTitle>
              <DialogDescription>
                {wizard.behavior}
              </DialogDescription>
            </DialogHeader>

            <div className="py-2">
              <CriteriaWizardStep2 wizard={wizard} />
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
                Create
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
