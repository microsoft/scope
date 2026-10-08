// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { CriteriaPicker } from "@/components/CriteriaPicker";
import { HelpTooltip } from "@/components/HelpTooltip";
import { gatesSatisfyInvariant, GATE_METADATA, orderGateIds } from "@/lib/gates";
import { Loader2, Check, RefreshCw } from "lucide-react";
import type { CriteriaWizardState } from "@/hooks/useCriteriaWizard";

interface CriteriaWizardStep2Props {
  wizard: CriteriaWizardState;
}

export function CriteriaWizardStep2({ wizard }: CriteriaWizardStep2Props) {
  const {
    behavior,
    id,
    dependsOn,
    setDependsOn,
    gates,
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
            Criteria for: {behavior}
          </p>
          <p className="text-xs text-muted-foreground uppercase tracking-wide mt-1">
            Behavior to track
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
            Criteria ID
          </p>
          <Badge variant="secondary" className="font-mono">
            {id}
          </Badge>
        </div>
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
      </div>

      <Separator />

      {/* Parents */}
      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground uppercase tracking-wide font-semibold">
          Parents
        </Label>
        <CriteriaPicker
          selected={dependsOn}
          onChange={setDependsOn}
          aiSuggested={suggestedParents}
          filter={(c) => gatesSatisfyInvariant(c.gates, gates) && !acceptedChildren.includes(c.id)}
        />
        {!hasCompatibleParentCandidates && (
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
          Criteria that must pass before this one is evaluated. Only criteria compatible with
          every selected gate are shown. List only direct parents —
          the judge automatically evaluates all transitive ancestors in topological order,
          so you don't need to repeat a parent's own dependencies here.
        </p>
      </div>

      <Separator />

      {/* Children */}
      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground uppercase tracking-wide font-semibold">
          Children
        </Label>
        <CriteriaPicker
          selected={acceptedChildren}
          onChange={setAcceptedChildren}
          aiSuggested={suggestedChildren}
          filter={(c) => gatesSatisfyInvariant(gates, c.gates) && !dependsOn.includes(c.id)}
        />
        {!hasCompatibleChildCandidates && (
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
          These criteria will be updated to depend on <span className="font-mono">{id || "this criterion"}</span> after creation.
          Only criteria compatible with a subset of the selected gates are shown.
        </p>
      </div>

      <Separator />

      {/* Criteria Prompt */}
      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground uppercase tracking-wide font-semibold">
          {generateMutation.isPending
            ? "Generating criteria prompt…"
            : aiGenerated
              ? "Criteria Prompt (AI Generated)"
              : "Criteria Prompt"}
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
            placeholder="Write your evaluation prompt here. Describe what the judge should check for in the codebase…"
            className="font-mono text-sm"
          />
        )}

        {generateMutation.isError && (
          <p className="text-xs text-amber-600">
            AI generation failed — {generateMutation.error instanceof Error
              ? generateMutation.error.message
              : "register an Azure AI Foundry or GitHub Models key at /secrets/keys/new, or write your prompt manually"}
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
