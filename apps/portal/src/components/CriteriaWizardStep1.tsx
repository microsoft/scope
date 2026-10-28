// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { GateCompatibilityPicker } from "@/components/GateCompatibilityPicker";
import { ObservationTaxonomySelect } from "@/components/ObservationTaxonomySelect";
import type { CriteriaWizardState } from "@/hooks/useCriteriaWizard";

interface CriteriaWizardStep1Props {
  wizard: CriteriaWizardState;
  /** HTML id prefix to avoid collisions when rendered in different contexts */
  idPrefix?: string;
}

export function CriteriaWizardStep1({ wizard, idPrefix = "" }: CriteriaWizardStep1Props) {
  const {
    behavior,
    handleBehaviorChange,
    id,
    setId,
    setIdManuallyEdited,
    idValid,
    idExists,
    criteriaLoading,
    gates,
    setGates,
    lockedGates,
    kind,
    setKind,
    taxonomyElementId,
    setTaxonomyElementId,
    subject,
    setSubject,
  } = wizard;

  return (
    <div className="space-y-4">
      {/* Behavior description */}
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}behavior`} className="text-sm font-semibold">
          What behavior do you want to track?
        </Label>
        <Textarea
          id={`${idPrefix}behavior`}
          placeholder="Describe the behavior or pattern you want to detect (e.g., 'uses Azure Bicep for IaC', 'has unit tests', 'follows REST conventions')"
          value={behavior}
          onChange={(e) => handleBehaviorChange(e.target.value)}
          rows={4}
          className="resize-none"
        />
        <p className="text-xs text-muted-foreground">
          Describe what you want the judge to detect in your codebase
        </p>
      </div>

      {/* Criteria ID */}
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}criteria-id`} className="text-sm font-semibold">
          Criteria ID{" "}
          <span className="font-normal text-muted-foreground">
            (when judge returns true)
          </span>
        </Label>
        <Input
          id={`${idPrefix}criteria-id`}
          placeholder="e.g., has_unit_tests"
          value={id}
          onChange={(e) => {
            setId(e.target.value);
            setIdManuallyEdited(true);
          }}
          pattern="[a-z][a-z0-9_]*"
          className="font-mono"
        />
        {id && !idValid && (
          <p className="text-xs text-destructive">
            Must start with a letter. Only lowercase letters, numbers, and underscores.
          </p>
        )}
        {id && idValid && idExists && (
          <p className="text-xs text-destructive">
            Criteria "{id}" already exists — choose a different ID
          </p>
        )}
        {id && idValid && criteriaLoading && (
          <p className="text-xs text-muted-foreground">
            Checking ID availability…
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {id && !wizard.idManuallyEdited
            ? "Auto-generated from behavior — edit to customize"
            : "This ID will be attached to evaluations when the judge evaluates them as positive"}
        </p>
      </div>

      {/* Criteria kind */}
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}criteria-kind`} className="text-sm font-semibold">
          Criteria kind
        </Label>
        <Select value={kind} onValueChange={(value) => setKind(value as typeof kind)}>
          <SelectTrigger id={`${idPrefix}criteria-kind`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="gate">Gate — steers the agent (pass/fail feedback shapes its next iteration)</SelectItem>
            <SelectItem value="observation">Observation — records evidence; never shown to the agent</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Gate criteria steer the agent — their pass/fail verdict is fed back into the coding
          session and shapes what it does next. Observations are recorded for analysis only:
          never shown to the agent and never change its behavior.
        </p>
      </div>

      {/* Gate compatibility */}
      {kind === "gate" ? (
        <div className="space-y-2">
          <Label className="text-sm font-semibold">Gate compatibility</Label>
          <GateCompatibilityPicker value={gates} onChange={setGates} lockedGates={lockedGates} />
          <p className="text-xs text-muted-foreground">
            Select the gates this criterion applies to. Parents must be compatible with every
            selected gate. This drives the gate-aware parent/child suggestions on the next step.
          </p>
        </div>
      ) : (
        <>
          <ObservationTaxonomySelect
            id={`${idPrefix}taxonomy`}
            value={taxonomyElementId}
            onChange={setTaxonomyElementId}
          />

          {/* Evaluation subject (observations only) */}
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}criteria-subject`} className="text-sm font-semibold">
              Evaluation subject
            </Label>
            <Select value={subject} onValueChange={(value) => setSubject(value as typeof subject)}>
              <SelectTrigger id={`${idPrefix}criteria-subject`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="run">Whole run — evaluated once across all iterations</SelectItem>
                <SelectItem value="iteration">Per iteration — evaluated on each iteration in isolation</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Whole-run observations span iterations (e.g. a dependency added then later removed),
              evaluated once against the final snapshot plus the merged trajectory. Per-iteration
              observations are judged independently on each iteration.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
