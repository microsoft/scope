// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { PORTAL_AI_REGISTRATION_GUIDANCE } from "@/lib/portal-ai-copy";
import { CriteriaPicker } from "@/components/CriteriaPicker";
import { HelpTooltip } from "@/components/HelpTooltip";
import { gatesSatisfyInvariant, GATE_METADATA, orderGateIds } from "@/lib/gates";
import { TAXONOMY_ELEMENT_METADATA } from "@/types";
import { Loader2, Check, RefreshCw } from "lucide-react";
import type { CriteriaWizardState } from "@/hooks/useCriteriaWizard";

interface CriteriaWizardStep2Props {
  wizard: CriteriaWizardState;
  observationMode?: boolean;
}

export function CriteriaWizardStep2({
  wizard,
  observationMode = false,
}: CriteriaWizardStep2Props) {
  const {
    behavior,
    id,
    dependsOn,
    setDependsOn,
    gates,
    kind = "gate",
    taxonomyElementId,
    prompt,
    setPrompt,
    aiGenerated,
    setAiGenerated,
    suggestedParents,
    suggestedChildren,
    acceptedChildren,
    setAcceptedChildren,
    hasCompatibleParentCandidates,
    hasCompatibleChildCandidates,
    handleRegenerate,
    generateMutation,
    createMutation,
  } = wizard;

  return (
    <div className="space-y-5">
      {/* Summary */}
      <div className="space-y-3">
        <div>
          <p className="text-sm font-semibold">
            {observationMode ? "Observation" : "Criteria"} for: {behavior}
          </p>
          <p className="text-xs text-muted-foreground uppercase tracking-wide mt-1">
            {observationMode ? "Behavior observed" : "Behavior to track"}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
            {observationMode ? "Observation ID" : "Criteria ID"}
          </p>
          <Badge variant="secondary" className="font-mono">
            {id}
          </Badge>
        </div>
        {!observationMode && (
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
              Kind
            </p>
            <Badge variant={kind === "observation" ? "outline" : "secondary"}>
              {kind === "observation" ? "Observation" : "Gate"}
            </Badge>
          </div>
        )}
        {kind === "gate" ? (
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
            Gate compatibility
          </p>
          <div className="flex flex-wrap gap-1.5">
            {!gates || gates.length === 0 ? (
              <Badge variant="outline">All gates</Badge>
            ) : (
              orderGateIds(gates).map((g) => (
                <Badge key={g} variant="outline">
                  {GATE_METADATA[g].label}
                </Badge>
              ))
            )}
          </div>
        </div>
        ) : (
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
              Observation dimension
            </p>
            <Badge variant="outline">
              {taxonomyElementId ? TAXONOMY_ELEMENT_METADATA[taxonomyElementId].label : "Unclassified"}
            </Badge>
          </div>
        )}
      </div>

      <Separator />

      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground uppercase tracking-wide font-semibold">
          Parents
        </Label>
        <CriteriaPicker
          selected={dependsOn}
          onChange={setDependsOn}
          aiSuggested={suggestedParents}
          kind={observationMode ? "observation" : undefined}
          entityLabel={observationMode ? "observations" : undefined}
          filter={(c) =>
            (c.kind ?? "gate") === kind &&
            (kind === "observation" || gatesSatisfyInvariant(c.gates, gates)) &&
            !acceptedChildren.includes(c.id)
          }
        />
        {!observationMode && !hasCompatibleParentCandidates && (
          <div className="flex items-center gap-1 text-xs font-medium text-amber-600" role="note">
            <span>No gate-compatible criteria available as parents.</span>
            <HelpTooltip
              size="xs"
              ariaLabel="Why no parents are available"
              text="A parent must be compatible with all of this criterion's gates — none of the existing criteria qualify. Change the gates, or create the parent criterion first."
            />
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          {observationMode
            ? "Observations that must be evaluated before this one. Only observations are shown."
            : `Criteria that must pass before this one is evaluated. ${kind === "gate" ? "Only criteria compatible with every selected gate are shown." : "Only observation criteria are shown."}`} List only direct parents —
          the judge automatically evaluates all transitive ancestors in topological order,
          so you don't need to repeat a parent's own dependencies here.
        </p>
      </div>

      <Separator />

      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground uppercase tracking-wide font-semibold">
          Children
        </Label>
        <CriteriaPicker
          selected={acceptedChildren}
          onChange={setAcceptedChildren}
          aiSuggested={suggestedChildren}
          kind={observationMode ? "observation" : undefined}
          entityLabel={observationMode ? "observations" : undefined}
          filter={(c) =>
            (c.kind ?? "gate") === kind &&
            (kind === "observation" || gatesSatisfyInvariant(gates, c.gates)) &&
            !dependsOn.includes(c.id)
          }
        />
        {!observationMode && !hasCompatibleChildCandidates && (
          <div className="flex items-center gap-1 text-xs font-medium text-amber-600" role="note">
            <span>No gate-compatible criteria available as children.</span>
            <HelpTooltip
              size="xs"
              ariaLabel="Why no children are available"
              text="A child must be compatible with a subset of this criterion's gates — none of the existing criteria qualify. Change the gates, or create the child criterion first."
            />
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          {observationMode ? "These observations" : "These criteria"} will be updated to depend on{" "}
          <span className="font-mono">
            {id || (observationMode ? "this observation" : "this criterion")}
          </span>{" "}
          after creation.
          {observationMode
            ? " Only observations are shown."
            : kind === "gate"
              ? " Only criteria compatible with a subset of the selected gates are shown."
              : " Only observation criteria are shown."}
        </p>
      </div>

      <Separator />

      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground uppercase tracking-wide font-semibold">
          {generateMutation.isPending
            ? `Generating ${observationMode ? "observation" : "criteria"} prompt…`
            : aiGenerated
              ? `${observationMode ? "Observation" : "Criteria"} Prompt (AI Generated)`
              : `${observationMode ? "Observation" : "Criteria"} Prompt`}
        </Label>

        {generateMutation.isPending ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            <span className="text-sm">Generating evaluation prompt…</span>
          </div>
        ) : (
          <Textarea
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value);
              if (aiGenerated) setAiGenerated(false);
            }}
            rows={6}
            placeholder={
              observationMode
                ? "Write the observation prompt here. Describe what evidence the judge should record…"
                : "Write your evaluation prompt here. Describe what the judge should check for in the codebase…"
            }
            className="font-mono text-sm"
          />
        )}

        {generateMutation.isError && (
          <p className="text-xs text-amber-600">
            AI generation failed — {generateMutation.error instanceof Error
              ? generateMutation.error.message
              : PORTAL_AI_REGISTRATION_GUIDANCE}
          </p>
        )}

        {/* Prompt action buttons */}
        {!generateMutation.isPending && (
          <div className="flex items-center gap-2">
            {prompt && aiGenerated && (
              <Button
                type="button"
                variant="default"
                size="sm"
                className="gap-1.5"
                onClick={() => setAiGenerated(false)}
              >
                <Check className="h-3.5 w-3.5" />
                Accept Prompt
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={handleRegenerate}
              disabled={generateMutation.isPending}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Regenerate
            </Button>
          </div>
        )}
      </div>

      {/* Error display */}
      {createMutation.isError && (
        <p className="text-sm text-destructive">
          {createMutation.error instanceof Error
            ? createMutation.error.message
            : "Creation failed"}
        </p>
      )}
    </div>
  );
}
