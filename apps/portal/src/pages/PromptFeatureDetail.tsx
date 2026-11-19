// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Save, Trash2, Loader2, Sparkles, Check, X } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { DetailPanel } from "@/components/list-layout";

export function PromptFeatureDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: feature, isLoading, error } = useQuery({
    queryKey: ["prompt-feature", id],
    queryFn: () => api.getPromptFeature(id!),
    enabled: !!id,
  });

  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState("");

  // AI Suggest state
  const [aiSuggestOpen, setAiSuggestOpen] = useState(false);
  const [behaviorInput, setBehaviorInput] = useState("");
  const [suggestedPrompt, setSuggestedPrompt] = useState<string | null>(null);

  const updateMutation = useMutation({
    mutationFn: (body: { prompt?: string }) =>
      api.updatePromptFeature(id!, body),
    onSuccess: () => {
      setEditing(false);
      setAiSuggestOpen(false);
      setSuggestedPrompt(null);
      queryClient.invalidateQueries({ queryKey: ["prompt-feature", id] });
      queryClient.invalidateQueries({ queryKey: ["prompt-features"] });
    },
  });

  const aiSuggestMutation = useMutation({
    mutationFn: (behavior: string) => api.generatePromptFeaturePrompt(behavior, id),
    onSuccess: (data) => {
      setSuggestedPrompt(data.prompt);
    },
    onError: () => {
      setSuggestedPrompt(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: api.deletePromptFeature,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["prompt-features"] });
      navigate("/prompt-features");
    },
  });

  const startEditing = () => {
    if (!feature) return;
    setPrompt(feature.prompt);
    setAiSuggestOpen(false);
    setBehaviorInput("");
    setSuggestedPrompt(null);
    setEditing(true);
  };

  const handleSave = () => {
    updateMutation.mutate({
      prompt: prompt.trim(),
    });
  };

  const handleAiSuggest = () => {
    if (!behaviorInput.trim()) return;
    aiSuggestMutation.mutate(behaviorInput.trim());
  };

  const handleAcceptPrompt = () => {
    if (suggestedPrompt) setPrompt(suggestedPrompt);
    setSuggestedPrompt(null);
  };

  const handleDismissPrompt = () => {
    setSuggestedPrompt(null);
  };

  const closePanel = () => navigate("/prompt-features");

  if (isLoading) {
    return (
      <DetailPanel title="Loading…" onClose={closePanel}>
        <div className="space-y-3">
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-32 w-full" />
        </div>
      </DetailPanel>
    );
  }

  if (error || !feature) {
    return (
      <DetailPanel title="Not found" onClose={closePanel}>
        <p className="text-sm text-muted-foreground">Prompt feature not found.</p>
      </DetailPanel>
    );
  }

  return (
    <DetailPanel
      title={<span className="font-mono">{feature.id}</span>}
      subtitle={
        <>
          Created {formatDate(feature.createdAt)}
          {feature.updatedAt && ` · Updated ${formatDate(feature.updatedAt)}`}
        </>
      }
      onClose={closePanel}
    >
      <div className="space-y-5">
        <p className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
          <span className="font-semibold text-foreground">Metadata only.</span>{" "}
          This feature categorizes task prompts so you can filter and slice runs
          during analysis. It does not change the prompt given to an agent, how a
          run executes, or how results are scored.
        </p>

        {/* Header actions */}
        <div className="flex items-center justify-end gap-2">
          {!editing && (
            <Button variant="outline" size="sm" onClick={startEditing}>
              Edit
            </Button>
          )}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="sm" className="gap-1.5">
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete prompt feature?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently delete <strong>{feature.id}</strong>. This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => deleteMutation.mutate(feature.id)}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>

        {/* Prompt */}
        <section className="space-y-2">
          <div>
            <h3 className="text-sm font-semibold">Detection Prompt</h3>
            <p className="text-xs text-muted-foreground">
              The prompt used to detect this feature in task text
            </p>
          </div>
          {editing ? (
            <div className="space-y-4">
              <Textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={6}
                className="font-mono text-sm"
              />

              {/* AI Suggest section */}
              {!aiSuggestOpen ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => setAiSuggestOpen(true)}
                >
                  <Sparkles className="h-4 w-4" />
                  AI Suggest
                </Button>
              ) : (
                <div className="space-y-3 rounded-md border p-3 bg-muted/30">
                  <Label className="text-xs text-muted-foreground uppercase tracking-wide font-semibold">
                    AI Suggest
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      value={behaviorInput}
                      onChange={(e) => setBehaviorInput(e.target.value)}
                      placeholder="Describe the feature to refine suggestions..."
                      className="text-sm"
                      onKeyDown={(e) => e.key === "Enter" && handleAiSuggest()}
                    />
                    <Button
                      size="sm"
                      onClick={handleAiSuggest}
                      disabled={aiSuggestMutation.isPending || !behaviorInput.trim()}
                      className="gap-1.5"
                    >
                      {aiSuggestMutation.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Sparkles className="h-4 w-4" />
                      )}
                      Generate
                    </Button>
                  </div>

                  {aiSuggestMutation.isError && (
                    <p className="text-sm text-destructive">
                      {aiSuggestMutation.error instanceof Error
                        ? aiSuggestMutation.error.message
                        : "AI suggestion failed"}
                    </p>
                  )}

                  {/* Suggested prompt */}
                  {suggestedPrompt && (
                    <div className="space-y-2 border rounded-md p-3 bg-background">
                      <div className="flex items-center justify-between">
                        <Label className="text-xs text-muted-foreground uppercase tracking-wide font-semibold">
                          Suggested Prompt
                        </Label>
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 gap-1 text-xs"
                            onClick={handleAcceptPrompt}
                          >
                            <Check className="h-3 w-3" /> Accept
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 gap-1 text-xs"
                            onClick={handleDismissPrompt}
                          >
                            <X className="h-3 w-3" /> Dismiss
                          </Button>
                        </div>
                      </div>
                      <p className="whitespace-pre-wrap text-sm font-mono bg-muted/50 rounded p-2">
                        {suggestedPrompt}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <p className="whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-sm">{feature.prompt}</p>
          )}
        </section>

        {/* Edit actions */}
        {editing && (
          <>
            <Separator />
            <div className="flex items-center justify-between">
              {updateMutation.isError && (
                <p className="text-sm text-destructive">
                  {updateMutation.error instanceof Error ? updateMutation.error.message : "Update failed"}
                </p>
              )}
              <div className="flex-1" />
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={handleSave} disabled={updateMutation.isPending} className="gap-1.5">
                  {updateMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  Save
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </DetailPanel>
  );
}

