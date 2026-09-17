// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * TaskPromptFeatures — shared component for displaying & extracting prompt
 * features. Supports two modes:
 *
 *   1. Entity mode (taskPromptId provided) — fetches stored features,
 *      extracts via entity endpoint, supports toggle.
 *   2. Text mode (text provided, no taskPromptId) — extracts from raw text,
 *      shows read-only badges. When taskPromptId is later supplied the
 *      pre-extracted features are automatically attached to the entity.
 *
 * Used by:
 *   - TaskPromptList (creation dialog, step 2 — text mode → entity mode)
 *   - TaskPromptDetail (features card — entity mode)
 *   - SubmitRun (step 2 review — entity mode)
 */

import { useState, useEffect, useRef, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import {
  Loader2, Sparkles, CheckCircle2, Plus, Check, RefreshCw,
  ListFilter,
} from "lucide-react";
import type { TaskPromptFeatureExtractionResult, SuggestedPromptFeature, PromptFeatureResult } from "@/types";
import { PromptFeatureWizard } from "@/components/PromptFeatureWizard";
import { toast } from "sonner";

interface TaskPromptFeaturesProps {
  /** Task prompt entity ID — when provided, enables entity mode (toggle, persist). */
  taskPromptId?: string;
  /** Raw prompt text — enables text-only extraction when taskPromptId is absent. */
  text?: string;
  /** Auto-extract on mount if no features exist (default: true) */
  autoExtract?: boolean;
  /** Use compact layout without Card wrapper (default: false) */
  compact?: boolean;
}

export function TaskPromptFeatures({
  taskPromptId,
  text,
  autoExtract = true,
  compact = false,
}: TaskPromptFeaturesProps) {
  const queryClient = useQueryClient();
  const hasAutoExtracted = useRef(false);
  const hasAttachedFeatures = useRef(false);

  // Whether we're operating in entity mode (taskPromptId provided)
  const entityMode = !!taskPromptId;

  // Extraction result state — tracks the latest extraction response (includes suggestedFeatures)
  const [extraction, setExtraction] = useState<TaskPromptFeatureExtractionResult | null>(null);

  // Sheet wizard state
  const [activeSuggestion, setActiveSuggestion] = useState<SuggestedPromptFeature | null>(null);
  const [createdSuggestionIds, setCreatedSuggestionIds] = useState<Set<string>>(new Set());

  // Manual feature picker state
  const [showManualPicker, setShowManualPicker] = useState(false);
  const [manualFilter, setManualFilter] = useState("");
  const [manuallyAddedIds, setManuallyAddedIds] = useState<Set<string>>(new Set());

  // Fetch all prompt features from the registry (for manual selection)
  const { data: allPromptFeatures = [] } = useQuery({
    queryKey: ["prompt-features"],
    queryFn: () => api.listPromptFeatures(),
    enabled: showManualPicker,
  });

  // Fetch the task prompt to check if features already exist (entity mode only)
  const { data: taskPrompt } = useQuery({
    queryKey: ["task-prompt", taskPromptId],
    queryFn: () => api.getTaskPrompt(taskPromptId!),
    enabled: entityMode,
  });

  // Entity-mode extraction (persists results)
  const extractEntityMutation = useMutation({
    mutationFn: (opts?: { force?: boolean }) =>
      api.extractTaskPromptFeatures(taskPromptId!, { force: opts?.force }),
    onSuccess: (data) => {
      setExtraction(data);
      queryClient.invalidateQueries({ queryKey: ["task-prompt", taskPromptId] });
      queryClient.invalidateQueries({ queryKey: ["task-prompts"] });
    },
  });

  // Text-mode extraction (no persistence)
  const extractTextMutation = useMutation({
    mutationFn: () => api.extractFeaturesFromText(text!),
    onSuccess: (data) => {
      setExtraction(data);
    },
  });

  // Unified accessor
  const extractMutation = entityMode ? extractEntityMutation : extractTextMutation;

  const toggleMutation = useMutation({
    mutationFn: ({ featureId, detected }: { featureId: string; detected: boolean }) =>
      api.toggleTaskPromptFeature(taskPromptId!, featureId, detected),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["task-prompt", taskPromptId] });
      queryClient.invalidateQueries({ queryKey: ["task-prompts"] });
      // Clear cached extraction so we re-read from server
      setExtraction(null);
    },
  });

  // When taskPromptId appears after text-mode extraction, attach pre-extracted features
  useEffect(() => {
    if (
      entityMode &&
      extraction?.features?.length &&
      !extraction.taskPromptId &&
      !hasAttachedFeatures.current
    ) {
      hasAttachedFeatures.current = true;
      // Re-extract via entity endpoint to persist & pick up entity-level caching
      extractEntityMutation.mutate({ force: true });
    }
  }, [entityMode, extraction]);

  // Auto-extract on mount
  useEffect(() => {
    if (!autoExtract || hasAutoExtracted.current) return;
    if (extractMutation.isPending) return;

    if (entityMode) {
      // Entity mode: auto-extract when entity has no features
      if (taskPrompt && !taskPrompt.features?.length) {
        hasAutoExtracted.current = true;
        extractEntityMutation.mutate({});
      }
    } else if (text?.trim()) {
      // Text mode: auto-extract from raw text
      hasAutoExtracted.current = true;
      extractTextMutation.mutate();
    }
  }, [autoExtract, taskPrompt, text, entityMode, extractMutation.isPending]);

  // Derive feature groups from extraction result or task prompt's stored features
  const extractedFeatures: PromptFeatureResult[] = extraction?.features ?? taskPrompt?.features ?? [];

  // In text mode, merge manually added features into the list
  const features: PromptFeatureResult[] = useMemo(() => {
    if (entityMode || manuallyAddedIds.size === 0) return extractedFeatures;
    const existingIds = new Set(extractedFeatures.map((f) => f.featureId));
    const manualFeatures: PromptFeatureResult[] = [...manuallyAddedIds]
      .filter((id) => !existingIds.has(id))
      .map((id) => ({ featureId: id, detected: true, evaluated: true }));
    return [...extractedFeatures, ...manualFeatures];
  }, [extractedFeatures, manuallyAddedIds, entityMode]);

  const detectedFeatures = features.filter((f) => f.detected);
  const suggestedFeatures = extraction?.suggestedFeatures ?? [];
  const hasFeatures = features.length > 0;
  const canToggle = entityMode;

  const featuresContent = (
    <div className="space-y-4 min-w-0">
      {/* Header with extract/re-extract button */}
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          {!compact && (
            <h3 className="text-sm font-medium">Prompt Features</h3>
          )}
          <p className="text-xs text-muted-foreground">
            {extractMutation.isPending
              ? "Analyzing task prompt…"
              : extraction?.cached
                ? "Loaded from cache (same task text was analyzed before)"
                : taskPrompt?.featuresExtractedAt
                  ? `Last extracted ${new Date(taskPrompt.featuresExtractedAt).toLocaleString()}`
                  : hasFeatures
                    ? "Features extracted"
                    : "Features have not been extracted yet"}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => entityMode ? extractEntityMutation.mutate({ force: true }) : extractTextMutation.mutate()}
          disabled={extractMutation.isPending}
        >
          {extractMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : hasFeatures ? (
            <RefreshCw className="h-4 w-4" />
          ) : (
            <Sparkles className="h-4 w-4" />
          )}
          {hasFeatures ? "Re-extract" : "Extract Features"}
        </Button>
      </div>

      {/* Loading state */}
      {extractMutation.isPending && (
        <div className="flex items-center gap-2 text-muted-foreground py-4">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Extracting prompt features…</span>
        </div>
      )}

      {/* Error state */}
      {extractMutation.isError && (
        <p className="text-sm text-destructive py-2">
          {extractMutation.error instanceof Error
            ? extractMutation.error.message
            : "Feature extraction failed"}
        </p>
      )}

      {/* Feature badges — only detected features are shown */}
      {detectedFeatures.length > 0 && !extractMutation.isPending && (
        <div className="space-y-3">
          {canToggle && (
            <p className="text-xs text-muted-foreground italic">
              Click a feature to mark it as not detected
            </p>
          )}
          <div>
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
              Detected ({detectedFeatures.length})
            </h4>
            <div className="flex flex-wrap gap-1.5">
              {detectedFeatures.map((f) => (
                <Badge
                  key={f.featureId}
                  variant="default"
                  className={`gap-1 font-mono text-xs ${canToggle ? "cursor-pointer hover:bg-destructive/80" : ""} transition-colors`}
                  title={canToggle ? `Click to mark "${f.featureId}" as not detected` : f.featureId}
                  onClick={canToggle ? () => toggleMutation.mutate({ featureId: f.featureId, detected: false }) : undefined}
                >
                  <CheckCircle2 className="h-3 w-3" />
                  {f.featureId}
                </Badge>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Manual feature picker */}
      {!extractMutation.isPending && (
        <>
          <Separator />
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-0.5">
                  Manual Selection
                </h4>
                <p className="text-xs text-muted-foreground">
                  Add or remove features from the registry
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => setShowManualPicker(!showManualPicker)}
              >
                <ListFilter className="h-4 w-4" />
                {showManualPicker ? "Hide" : "Browse"}
              </Button>
            </div>

            {showManualPicker && (
              <div className="space-y-2">
                <Input
                  placeholder="Filter features…"
                  value={manualFilter}
                  onChange={(e) => setManualFilter(e.target.value)}
                  className="h-8 text-sm"
                />
                <ScrollArea className="h-48 rounded-md border">
                  <div className="p-2 space-y-1">
                    {allPromptFeatures.length === 0 ? (
                      <p className="text-xs text-muted-foreground italic py-2 text-center">
                        No prompt features in registry
                      </p>
                    ) : (
                      allPromptFeatures
                        .filter((pf) =>
                          !manualFilter || pf.id.toLowerCase().includes(manualFilter.toLowerCase())
                        )
                        .map((pf) => {
                          const isPresent = features.some((f) => f.featureId === pf.id);
                          const isDetected = features.some(
                            (f) => f.featureId === pf.id && f.detected
                          );
                          return (
                            <label
                              key={pf.id}
                              className="flex items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-accent cursor-pointer"
                            >
                              <Checkbox
                                checked={isPresent && isDetected}
                                onCheckedChange={(checked) => {
                                  const detected = !!checked;
                                  if (entityMode) {
                                    toggleMutation.mutate({ featureId: pf.id, detected });
                                  } else {
                                    // Text mode: update local state
                                    setManuallyAddedIds((prev) => {
                                      const next = new Set(prev);
                                      if (detected) {
                                        next.add(pf.id);
                                      } else {
                                        next.delete(pf.id);
                                      }
                                      return next;
                                    });
                                  }
                                }}
                                disabled={entityMode && toggleMutation.isPending}
                              />
                              <div className="flex-1 min-w-0">
                                <span className="text-sm font-mono">{pf.id}</span>
                                {pf.prompt && (
                                  <p className="text-xs text-muted-foreground truncate">
                                    {pf.prompt}
                                  </p>
                                )}
                              </div>
                              {isPresent && (
                                <Badge
                                  variant={isDetected ? "default" : "outline"}
                                  className="text-[10px] px-1.5 py-0 shrink-0"
                                >
                                  {isDetected ? "detected" : "not detected"}
                                </Badge>
                              )}
                            </label>
                          );
                        })
                    )}
                  </div>
                </ScrollArea>
              </div>
            )}
          </div>
        </>
      )}

      {/* Suggested new features */}
      {suggestedFeatures.length > 0 && !extractMutation.isPending && (
        <>
          <Separator />
          <div className="space-y-3">
            <div>
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-0.5">
                Suggested New Features
              </h4>
              <p className="text-xs text-muted-foreground">
                The AI detected characteristics not covered by existing features
              </p>
            </div>
            {suggestedFeatures.map((s) => {
              const alreadyCreated = createdSuggestionIds.has(s.suggestedId);
              return (
                <div
                  key={s.suggestedId}
                  className={`flex items-start justify-between gap-3 rounded-md border p-3 ${alreadyCreated ? "opacity-60" : ""}`}
                >
                  <div className="space-y-1 min-w-0">
                    <Badge variant="secondary" className="font-mono text-xs">
                      {s.suggestedId}
                    </Badge>
                    <p className="text-sm text-muted-foreground">{s.behavior}</p>
                  </div>
                  {alreadyCreated ? (
                    <Badge variant="outline" className="gap-1 shrink-0 text-xs">
                      <Check className="h-3 w-3" />
                      Created
                    </Badge>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="gap-1 shrink-0"
                      onClick={() => setActiveSuggestion(s)}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Create
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Sheet: Create Prompt Feature Wizard */}
      <Sheet
        open={activeSuggestion !== null}
        onOpenChange={(open) => {
          if (!open) setActiveSuggestion(null);
        }}
      >
        <SheetContent side="right" className="sm:max-w-xl w-full overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Create Prompt Feature</SheetTitle>
            <SheetDescription>
              Create a new feature suggested by the extraction analysis
            </SheetDescription>
          </SheetHeader>
          {activeSuggestion && (
            <div className="mt-6">
              <PromptFeatureWizard
                key={activeSuggestion.suggestedId}
                initialBehavior={activeSuggestion.behavior}
                initialId={activeSuggestion.suggestedId}
                initialPrompt={activeSuggestion.prompt}
                onCreated={(feature) => {
                  setCreatedSuggestionIds((prev) => new Set(prev).add(activeSuggestion.suggestedId));
                  setActiveSuggestion(null);
                  toast.success(`Feature "${feature.id}" created`);
                  // Re-extract with force to pick up the new feature
                  if (entityMode) {
                    extractEntityMutation.mutate({ force: true });
                  }
                }}
                onCancel={() => setActiveSuggestion(null)}
              />
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );

  return featuresContent;
}
