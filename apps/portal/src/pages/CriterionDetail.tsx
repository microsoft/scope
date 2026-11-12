// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Save, Trash2, Loader2, Sparkles, Check, X, Plus, Download } from "lucide-react";
import { CriteriaPicker } from "@/components/CriteriaPicker";
import { CriteriaKindBadge, CriteriaSubjectBadge } from "@/components/CriteriaBadge";
import { GateCompatibilityPicker } from "@/components/GateCompatibilityPicker";
import { ObservationTaxonomySelect } from "@/components/ObservationTaxonomySelect";
import { formatDate } from "@/lib/utils";
import {
  formatGateList,
  gatesSatisfyInvariant,
  type GateId,
} from "@/lib/gates";
import { useCommandEnter } from "@/hooks/useCommandEnter";
import { KbdBadge } from "@/components/KbdBadge";
import { criteriaToExportYaml, downloadAsFile } from "@/lib/criteria-export";
import { toast } from "sonner";
import { TAXONOMY_ELEMENT_METADATA, type CriterionKind, type CriterionSubject, type TaxonomyElementId } from "@/types";

export function CriterionDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Cmd+Enter navigates to create new criterion
  useCommandEnter(() => navigate("/criteria/new"), true);

  const { data: criterion, isLoading, error } = useQuery({
    queryKey: ["criterion", id],
    queryFn: () => api.getCriterion(id!),
    enabled: !!id,
  });

  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [editDependsOn, setEditDependsOn] = useState<string[]>([]);
  const [editGates, setEditGates] = useState<GateId[] | undefined>(undefined);
  const [editKind, setEditKind] = useState<CriterionKind>("gate");
  const [editTaxonomyElementId, setEditTaxonomyElementId] = useState<TaxonomyElementId | undefined>(undefined);
  const [editSubject, setEditSubject] = useState<CriterionSubject>("run");

  // AI Suggest state
  const [aiSuggestOpen, setAiSuggestOpen] = useState(false);
  const [behaviorInput, setBehaviorInput] = useState("");
  const [suggestedPrompt, setSuggestedPrompt] = useState<string | null>(null);
  const [suggestedParents, setSuggestedParents] = useState<string[]>([]);
  const [suggestedChildren, setSuggestedChildren] = useState<string[]>([]);
  const [acceptedChildren, setAcceptedChildren] = useState<string[]>([]);

  const { data: allCriteria = [] } = useQuery({
    queryKey: ["criteria"],
    queryFn: () => api.listCriteria(),
  });

  const updateMutation = useMutation({
    mutationFn: (body: { prompt?: string; dependsOn?: string[]; gates?: GateId[]; kind?: CriterionKind; taxonomyElementId?: TaxonomyElementId; subject?: CriterionSubject }) =>
      api.updateCriterion(id!, body),
    onSuccess: async () => {
      // Update accepted children to depend on this criterion
      for (const childId of acceptedChildren) {
        try {
          const child = await api.getCriterion(childId);
          const existingDeps = child.dependsOn ?? [];
          if (!existingDeps.includes(id!)) {
            await api.updateCriterion(childId, {
              dependsOn: [...existingDeps, id!],
            });
          }
        } catch {
          // Non-blocking: child update failures are silently ignored
        }
      }
      setEditing(false);
      setAiSuggestOpen(false);
      setSuggestedPrompt(null);
      setSuggestedParents([]);
      setSuggestedChildren([]);
      setAcceptedChildren([]);
      queryClient.invalidateQueries({ queryKey: ["criterion", id] });
      queryClient.invalidateQueries({ queryKey: ["criteria"] });
    },
  });

  const aiSuggestMutation = useMutation({
    mutationFn: (behavior: string) => api.generateCriteriaPrompt(behavior, id),
    onSuccess: (data) => {
      setSuggestedPrompt(data.prompt);
      setSuggestedParents(data.suggestedParents);
      setSuggestedChildren(data.suggestedChildren);
      // Auto-accept: merge parents into deps, accept all children
      setEditDependsOn((prev) => [
        ...new Set([...prev, ...data.suggestedParents]),
      ]);
      setAcceptedChildren(data.suggestedChildren);
    },
    onError: () => {
      setSuggestedPrompt(null);
      setSuggestedParents([]);
      setSuggestedChildren([]);
      setAcceptedChildren([]);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: api.deleteCriterion,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["criteria"] });
      navigate("/criteria");
    },
  });

  const startEditing = () => {
    if (!criterion) return;
    setPrompt(criterion.prompt);
    setEditDependsOn(criterion.dependsOn ?? []);
    setEditGates(criterion.gates && criterion.gates.length > 0 ? criterion.gates : ["select"]);
    setEditKind(criterion.kind ?? "gate");
    setEditTaxonomyElementId(criterion.taxonomyElementId);
    setEditSubject(criterion.subject ?? ((criterion.kind ?? "gate") === "observation" ? "run" : "iteration"));
    setAiSuggestOpen(false);
    setBehaviorInput("");
    setSuggestedPrompt(null);
    setSuggestedParents([]);
    setSuggestedChildren([]);
    setAcceptedChildren([]);
    setEditing(true);
  };

  const handleSave = () => {
    if (editKind === "gate" && (!editGates || editGates.length === 0)) return;
    updateMutation.mutate({
      prompt: prompt.trim(),
      // Always send the array (even empty) so removing the last dependency
      // persists. The backend treats `undefined` as "no change", so collapsing
      // [] to undefined here silently dropped deletions.
      dependsOn: editDependsOn,
      ...(editKind === "gate" ? { gates: editGates } : {}),
      kind: editKind,
      taxonomyElementId: editKind === "observation" ? editTaxonomyElementId : undefined,
      // Subject only applies to observations; gates are always per-iteration.
      subject: editKind === "observation" ? editSubject : "iteration",
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

  const invariantErrors = editing
    ? [
        ...editDependsOn.flatMap((depId) => {
          const parent = allCriteria.find((c) => c.id === depId);
          return editKind === "gate" && parent && !gatesSatisfyInvariant(parent.gates, editGates)
            ? [`Parent '${depId}' must include ${formatGateList(editGates)}.`]
            : [];
        }),
        ...(criterion?.dependents.flatMap((childId) => {
          const child = allCriteria.find((c) => c.id === childId);
          return editKind === "gate" && child && !gatesSatisfyInvariant(editGates, child.gates)
            ? [`Dependent '${childId}' requires ${formatGateList(child.gates)} compatibility.`]
            : [];
        }) ?? []),
      ]
    : [];

  if (isLoading) {
    return (
      <div className="max-w-2xl space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !criterion) {
    return (
      <div className="max-w-2xl space-y-4">
        <Link to="/criteria" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back to Criteria
        </Link>
        <div className="text-center py-12 text-muted-foreground">
          Criterion not found
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      <Link to="/criteria" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Back to Criteria
      </Link>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight font-mono">{criterion.id}</h1>
          <p className="text-sm text-muted-foreground">
            Created {formatDate(criterion.createdAt)}
            {criterion.updatedAt && ` · Updated ${formatDate(criterion.updatedAt)}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!editing && (
            <>
              <Button variant="outline" asChild>
                <Link to="/criteria/new">
                  <Plus className="h-4 w-4 mr-1.5" />
                  New Criterion
                  <KbdBadge />
                </Link>
              </Button>
              <Button
                variant="outline"
                className="gap-1.5"
                onClick={async () => {
                  try {
                    const subset = await api.listCriteria(undefined, { ids: [criterion.id], ancestors: true });
                    const yaml = criteriaToExportYaml(subset);
                    downloadAsFile(yaml, `${criterion.id}.yaml`);
                  } catch (err) {
                    toast.error(`Failed to export: ${err instanceof Error ? err.message : String(err)}`);
                  }
                }}
              >
                <Download className="h-4 w-4" /> Export YAML
              </Button>
              <Button variant="outline" onClick={startEditing}>
                Edit
              </Button>
            </>
          )}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="icon" className="h-9 w-9">
                <Trash2 className="h-4 w-4" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete criterion?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently delete <strong>{criterion.id}</strong>.
                  {criterion.dependents.length > 0 && (
                    <span className="block mt-2 text-destructive">
                      Cannot delete: used by {criterion.dependents.join(", ")}
                    </span>
                  )}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => deleteMutation.mutate(criterion.id)}
                  disabled={criterion.dependents.length > 0}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* Prompt */}
      <Card>
        <CardHeader>
          <CardTitle>Prompt</CardTitle>
          <CardDescription>The evaluation prompt sent to the judge LLM</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {editing ? (
            <>
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
                      placeholder="Describe the behavior to refine suggestions..."
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

                  {/* Suggested parents */}
                  {suggestedParents.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-sm font-medium">
                        Parents{" "}
                        <span className="font-normal text-muted-foreground">
                          — this criterion should depend on:
                        </span>
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {suggestedParents.map((pid) => (
                          <Badge
                            key={pid}
                            variant={editDependsOn.includes(pid) ? "secondary" : "outline"}
                            className="gap-1.5 font-mono text-xs"
                          >
                            {editDependsOn.includes(pid) && <Check className="h-3 w-3" />}
                            {pid}
                            {editDependsOn.includes(pid) && (
                              <X
                                className="h-3 w-3 ml-0.5 cursor-pointer hover:text-destructive"
                                onClick={() =>
                                  setEditDependsOn((prev) => prev.filter((d) => d !== pid))
                                }
                              />
                            )}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Suggested children */}
                  {suggestedChildren.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-sm font-medium">
                        Children{" "}
                        <span className="font-normal text-muted-foreground">
                          — these criteria should depend on this one:
                        </span>
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {suggestedChildren.map((cid) => (
                          <Badge
                            key={cid}
                            variant={acceptedChildren.includes(cid) ? "secondary" : "outline"}
                            className="gap-1.5 font-mono text-xs cursor-pointer"
                            onClick={() => {
                              setAcceptedChildren((prev) =>
                                prev.includes(cid)
                                  ? prev.filter((c) => c !== cid)
                                  : [...prev, cid],
                              );
                            }}
                          >
                            {acceptedChildren.includes(cid) ? (
                              <Check className="h-3 w-3" />
                            ) : null}
                            {cid}
                            {acceptedChildren.includes(cid) && (
                              <X className="h-3 w-3 ml-0.5 hover:text-destructive" />
                            )}
                          </Badge>
                        ))}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Accepted children will be updated to depend on{" "}
                        <span className="font-mono">{criterion.id}</span> when you save
                      </p>
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <p className="whitespace-pre-wrap text-sm">{criterion.prompt}</p>
          )}
        </CardContent>
      </Card>

      {/* Kind */}
      <Card>
        <CardHeader>
          <CardTitle>Kind</CardTitle>
          <CardDescription>
            Gate criteria steer the agent (pass/fail feedback shapes its next iteration); observations only record evidence and are never shown to the agent.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {editing ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="criterion-kind">Criteria kind</Label>
                <Select value={editKind} onValueChange={(value) => setEditKind(value as CriterionKind)}>
                  <SelectTrigger id="criterion-kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="gate">Gate — steers the agent (pass/fail feedback shapes its next iteration)</SelectItem>
                    <SelectItem value="observation">Observation — records evidence; never shown to the agent</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {editKind === "observation" && (
                <>
                  <ObservationTaxonomySelect
                    id="criterion-taxonomy"
                    value={editTaxonomyElementId}
                    onChange={setEditTaxonomyElementId}
                  />
                  <div className="space-y-2">
                    <Label htmlFor="criterion-subject">Evaluation subject</Label>
                    <Select value={editSubject} onValueChange={(value) => setEditSubject(value as CriterionSubject)}>
                      <SelectTrigger id="criterion-subject">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="run">Whole run — evaluated once across all iterations</SelectItem>
                        <SelectItem value="iteration">Per iteration — evaluated on each iteration in isolation</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </>
              )}
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <CriteriaKindBadge kind={criterion.kind} />
              {(criterion.kind ?? "gate") === "observation" && (
                <>
                  <Badge variant="outline">
                    {criterion.taxonomyElementId
                      ? TAXONOMY_ELEMENT_METADATA[criterion.taxonomyElementId].label
                      : "Unclassified"}
                  </Badge>
                  <CriteriaSubjectBadge subject={criterion.subject} />
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Gate compatibility */}
      {(editing ? editKind === "gate" : (criterion.kind ?? "gate") === "gate") && (
      <Card>
        <CardHeader>
          <CardTitle>Gate compatibility</CardTitle>
          <CardDescription>
            Where this criterion can be selected.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {editing ? (
            <>
              <GateCompatibilityPicker value={editGates} onChange={setEditGates} />
              {invariantErrors.length > 0 && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                  <p className="font-medium">Compatibility invariant issues</p>
                  <ul className="mt-1 list-disc pl-5">
                    {invariantErrors.map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <Badge variant="secondary">{formatGateList(criterion.gates)}</Badge>
          )}
        </CardContent>
      </Card>
      )}

      {/* Dependencies */}
      <Card>
        <CardHeader>
          <CardTitle>Dependencies</CardTitle>
          <CardDescription>
            Criteria that must pass before this one is evaluated. List only direct parents —
            the judge automatically evaluates all transitive ancestors in topological order,
            so you don't need to repeat a parent's own dependencies here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {editing ? (
            <CriteriaPicker
              selected={editDependsOn}
              onChange={setEditDependsOn}
              kind={editKind}
              filter={(c) => c.id !== criterion.id && (editKind === "observation" || gatesSatisfyInvariant(c.gates, editGates))}
            />
          ) : (criterion.dependsOn ?? []).length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {criterion.dependsOn!.map((dep) => (
                <Link key={dep} to={`/criteria/${dep}`}>
                  <Badge variant="secondary" className="font-mono cursor-pointer hover:bg-secondary/80">
                    {dep}
                  </Badge>
                </Link>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No dependencies (root criterion)</p>
          )}
        </CardContent>
      </Card>

      {/* Dependents */}
      {criterion.dependents.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Dependents</CardTitle>
            <CardDescription>Criteria that depend on this one</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {criterion.dependents.map((dep) => (
                <Link key={dep} to={`/criteria/${dep}`}>
                  <Badge variant="outline" className="font-mono cursor-pointer hover:bg-accent">
                    {dep}
                  </Badge>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

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
              <Button variant="outline" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={updateMutation.isPending || invariantErrors.length > 0} className="gap-1.5">
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
  );
}
