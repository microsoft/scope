// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState, useMemo, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Stepper } from "@/components/Stepper";
import type { PromptFeatureDocument, PromptType } from "@/types";
import {
  ArrowLeft,
  ArrowRight,
  Loader2,
  Check,
  X,
  Sparkles,
  RefreshCw,
  Pencil,
} from "lucide-react";
import { useCommandEnter } from "@/hooks/useCommandEnter";
import { KbdBadge } from "@/components/KbdBadge";
import { slugify } from "@/lib/utils";

const STEPS = ["Define Feature", "Review & Create"];

export interface PromptFeatureWizardProps {
  /** Pre-fill behavior description */
  initialBehavior?: string;
  /** Pre-fill feature ID */
  initialId?: string;
  /** Pre-fill detection prompt (skips to step 2 when provided) */
  initialPrompt?: string;
  /** Pre-select the prompt type this feature applies to (default "select") */
  initialType?: PromptType;
  /** Called after successful feature creation */
  onCreated?: (feature: PromptFeatureDocument) => void;
  /** Called when user clicks Cancel (step 1) or Back at step 1 */
  onCancel?: () => void;
}

export function PromptFeatureWizard({
  initialBehavior = "",
  initialId = "",
  initialPrompt = "",
  initialType = "select",
  onCreated,
  onCancel,
}: PromptFeatureWizardProps) {
  const queryClient = useQueryClient();

  // Wizard step (1 or 2) — skip to 2 if prompt pre-filled
  const [step, setStep] = useState(initialPrompt ? 2 : 1);

  // Step 1 fields
  const [behavior, setBehavior] = useState(initialBehavior);
  const [id, setId] = useState(initialId);
  const [idManuallyEdited, setIdManuallyEdited] = useState(!!initialId);
  const [idEditMode, setIdEditMode] = useState(false);
  const [type, setType] = useState<PromptType>(initialType);

  // Step 2 fields
  const [prompt, setPrompt] = useState(initialPrompt);
  const [aiGenerated, setAiGenerated] = useState(false);
  const [aiModel, setAiModel] = useState("");

  // ID validation
  const idValid = useMemo(() => /^[a-z][a-z0-9_]*$/.test(id), [id]);
  const canContinue = behavior.trim().length > 0 && id.trim().length > 0 && idValid;

  // Auto-suggest ID from behavior (unless manually edited)
  const handleBehaviorChange = useCallback(
    (value: string) => {
      setBehavior(value);
      if (!idManuallyEdited) {
        setId(slugify(value));
      }
    },
    [idManuallyEdited],
  );

  // Generate prompt mutation
  const generateMutation = useMutation({
    mutationFn: (behaviorText: string) => api.generatePromptFeaturePrompt(behaviorText),
    onSuccess: (data) => {
      setPrompt(data.prompt);
      setAiGenerated(true);
      setAiModel("AI Generated");
      if (!idManuallyEdited && data.suggestedId) {
        setId(data.suggestedId);
      }
    },
    onError: () => {
      setPrompt("");
      setAiGenerated(false);
    },
  });

  // Create prompt feature mutation
  const createMutation = useMutation({
    mutationFn: api.createPromptFeature,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["prompt-features"] });
      onCreated?.(data);
    },
  });

  // Step 1 → Step 2
  const handleContinue = () => {
    setStep(2);
    generateMutation.mutate(behavior.trim());
  };

  // Step 2 → Submit
  const handleCreate = () => {
    if (!id.trim() || !prompt.trim()) return;
    createMutation.mutate({
      id: id.trim(),
      prompt: prompt.trim(),
      ...(type !== "select" ? { type } : {}),
    });
  };

  // Cmd+Enter / Ctrl+Enter shortcut for primary action
  useCommandEnter(
    step === 1 ? handleContinue : handleCreate,
    step === 1 ? canContinue : !!prompt.trim() && !createMutation.isPending,
  );

  // Regenerate prompt
  const handleRegenerate = () => {
    generateMutation.mutate(behavior.trim());
  };

  return (
    <div className="space-y-6">
      {step === 1 ? (
        /* ───────────────────── Step 1: Define Feature ───────────────────── */
        <>
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-10 h-10 rounded-full bg-muted">
                <Sparkles className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <h2 className="text-xl font-semibold">Define Prompt Feature</h2>
                <p className="text-sm text-muted-foreground">
                  Describe the characteristic to detect in task prompts. Features
                  only categorize prompts for analysis — they don&apos;t change
                  what agents are asked to do.
                </p>
              </div>
            </div>
            <Stepper steps={STEPS} currentStep={1} />
          </div>

          <Card>
            <CardContent className="pt-6 space-y-6">
              <div className="space-y-2">
                <Label htmlFor="wizard-behavior" className="text-sm font-semibold">
                  What characteristic do you want to detect?
                </Label>
                <Textarea
                  id="wizard-behavior"
                  placeholder="Describe the characteristic to detect in task prompts (e.g., 'asks the agent to deploy to Azure', 'requires Docker containers', 'needs a REST API')"
                  value={behavior}
                  onChange={(e) => handleBehaviorChange(e.target.value)}
                  rows={4}
                  className="resize-none"
                />
                <p className="text-xs text-muted-foreground">
                  Describe what you want to detect in the task prompt given to coding agents
                </p>
              </div>

              <div className="space-y-2">
                <Label className="text-sm font-semibold">Applies to</Label>
                <Select value={type} onValueChange={(v) => setType(v as PromptType)}>
                  <SelectTrigger className="w-full" aria-label="Prompt type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="select">Task prompts</SelectItem>
                    <SelectItem value="agents.md">AGENTS.md prompts</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Features are only extracted against prompts of their own type.
                </p>
              </div>

              <div className="space-y-2">
                <Label className="text-sm font-semibold">
                  Feature ID{" "}
                  <span className="font-normal text-muted-foreground">
                    (when feature is detected)
                  </span>
                </Label>

                {id && !idEditMode ? (
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="secondary"
                      className="gap-1.5 px-3 py-1.5 text-sm font-mono cursor-pointer hover:bg-secondary/80"
                      onClick={() => setIdEditMode(true)}
                    >
                      <Check className="h-3.5 w-3.5" />
                      {id}
                      <X
                        className="h-3.5 w-3.5 ml-1 hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          setId("");
                          setIdManuallyEdited(true);
                          setIdEditMode(true);
                        }}
                      />
                    </Badge>
                    <button
                      type="button"
                      onClick={() => setIdEditMode(true)}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <Input
                      placeholder="e.g., asks_for_docker"
                      value={id}
                      onChange={(e) => {
                        setId(e.target.value);
                        setIdManuallyEdited(true);
                      }}
                      onBlur={() => {
                        if (id) setIdEditMode(false);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && id) {
                          e.preventDefault();
                          setIdEditMode(false);
                        }
                      }}
                      pattern="[a-z][a-z0-9_]*"
                      className="font-mono"
                      autoFocus={idEditMode}
                    />
                    {id && !idValid && (
                      <p className="text-xs text-destructive">
                        Must start with a letter. Only lowercase letters, numbers, and underscores.
                      </p>
                    )}
                  </div>
                )}

                {!id && !idEditMode && (
                  <button
                    type="button"
                    onClick={() => setIdEditMode(true)}
                    className="flex items-center gap-2 px-3 py-2 border border-dashed rounded-md text-sm text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors w-full"
                  >
                    + Click to select or create feature ID
                  </button>
                )}

                <p className="text-xs text-muted-foreground">
                  This ID will be used to identify when the feature is detected in a task prompt
                </p>
              </div>
            </CardContent>
          </Card>

          <div className="flex items-center justify-between">
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              onClick={handleContinue}
              disabled={!canContinue}
              className="gap-1.5"
            >
              Continue
              <ArrowRight className="h-4 w-4" />
              <KbdBadge />
            </Button>
          </div>
        </>
      ) : (
        /* ───────────────────── Step 2: Review & Create ───────────────────── */
        <>
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-10 h-10 rounded-full bg-muted">
                <Sparkles className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <h2 className="text-xl font-semibold">Review & Create</h2>
                <p className="text-sm text-muted-foreground">
                  Confirm your prompt feature settings
                </p>
              </div>
            </div>
            <Stepper steps={STEPS} currentStep={2} />
          </div>

          <Card>
            <CardContent className="pt-6 space-y-4">
              <div className="space-y-3">
                <div>
                  <p className="text-sm font-semibold">
                    Feature for: {behavior}
                  </p>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide mt-1">
                    Characteristic to detect
                  </p>
                </div>

                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
                    Feature ID
                  </p>
                  <Badge variant="secondary" className="font-mono">
                    {id}
                  </Badge>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6 space-y-4">
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground uppercase tracking-wide font-semibold">
                  {generateMutation.isPending
                    ? "Generating detection prompt…"
                    : aiGenerated
                      ? `Detection Prompt (${aiModel})`
                      : "Detection Prompt"}
                </Label>

                {generateMutation.isPending ? (
                  <div className="flex items-center justify-center py-12 text-muted-foreground">
                    <Loader2 className="h-5 w-5 animate-spin mr-2" />
                    <span className="text-sm">Generating detection prompt…</span>
                  </div>
                ) : (
                  <Textarea
                    value={prompt}
                    onChange={(e) => {
                      setPrompt(e.target.value);
                      if (aiGenerated) setAiGenerated(false);
                    }}
                    rows={6}
                    placeholder="Write your detection prompt here. Describe what to look for in task prompts…"
                    className="font-mono text-sm"
                  />
                )}

                {generateMutation.isError && (
                  <p className="text-xs text-amber-600">
                    AI generation failed — {generateMutation.error instanceof Error ? generateMutation.error.message : "register an Azure AI Foundry or GitHub Models key at /secrets/keys/new, or write your prompt manually"}
                  </p>
                )}
              </div>

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
            </CardContent>
          </Card>

          {createMutation.isError && (
            <p className="text-sm text-destructive">
              {createMutation.error instanceof Error
                ? createMutation.error.message
                : "Creation failed"}
            </p>
          )}

          <div className="flex items-center justify-between">
            <Button
              variant="ghost"
              onClick={() => setStep(1)}
              className="gap-1.5"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </Button>
            <Button
              onClick={handleCreate}
              disabled={!prompt.trim() || createMutation.isPending}
              className="gap-1.5"
            >
              {createMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              Create Feature
              <KbdBadge />
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
