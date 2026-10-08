// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { SkillRevisionDocument } from "@/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Trash2, RefreshCw, Loader2, BookOpen, GitCommit, ExternalLink } from "lucide-react";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { formatDate } from "@/lib/utils";
import { shortCommitHash } from "@/lib/skill-spec";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export function SkillDetail() {
  const { "*": slug } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: skill, isLoading, error } = useQuery({
    queryKey: ["skill", slug],
    queryFn: () => api.getSkill(slug!),
    enabled: !!slug,
  });

  const { data: revisions = [], isLoading: loadingRevisions } = useQuery({
    queryKey: ["skill-revisions", slug],
    queryFn: () => api.listSkillRevisions(slug!),
    enabled: !!slug,
  });

  const latestRevision = revisions[0] ?? null;

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteSkill(slug!),
    onSuccess: () => {
      toast.success("Skill deleted");
      navigate("/skills");
    },
  });

  const resolveMutation = useMutation({
    mutationFn: () => api.resolveSkill(slug!),
    onSuccess: (revision) => {
      queryClient.invalidateQueries({ queryKey: ["skill-revisions", slug] });
      if (revision.validationWarnings?.length) {
        for (const warning of revision.validationWarnings) {
          toast.warning(warning);
        }
        toast.success("Skill resolved with warnings — new revision created");
      } else {
        toast.success("Skill resolved — new revision created");
      }
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Failed to resolve skill");
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !skill) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" className="gap-1.5" onClick={() => navigate("/skills")}>
          <ArrowLeft className="h-4 w-4" /> Back to Skills
        </Button>
        <div className="text-center py-12 text-muted-foreground">
          Skill not found
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Back link */}
      <Button variant="ghost" className="gap-1.5" onClick={() => navigate("/skills")}>
        <ArrowLeft className="h-4 w-4" /> Back to Skills
      </Button>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <BookOpen className="h-6 w-6" />
            <h1 className="text-2xl font-bold tracking-tight">{skill.name}</h1>
            <Badge variant="outline" className="text-xs">{skill.origin}</Badge>
          </div>
          <div className="flex items-center gap-3 mt-1">
            <p className="text-sm text-muted-foreground font-mono">{skill._id}</p>
            <a
              href={`https://github.com/${skill.source}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary hover:underline inline-flex items-center gap-1"
            >
              <ExternalLink className="h-3 w-3" /> GitHub
            </a>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={() => resolveMutation.mutate()}
            disabled={resolveMutation.isPending}
            variant="outline"
            className="gap-1.5"
          >
            {resolveMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Resolve
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="icon">
                <Trash2 className="h-4 w-4" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete skill?</AlertDialogTitle>
                <AlertDialogDescription>
                  This deletes the skill &quot;{skill.name}&quot; and all its revisions. It will no longer be available for new runs.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => deleteMutation.mutate()}>
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* Main layout: SKILL.md content + sidebar */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_20rem] gap-6">
        {/* Main content: rendered SKILL.md */}
        <Card className="min-w-0">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">SKILL.md</CardTitle>
              {latestRevision && (
                <span className="text-xs text-muted-foreground font-mono">
                  {shortCommitHash(latestRevision.commitHash)} · {formatDate(latestRevision.resolvedAt)}
                </span>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {loadingRevisions ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-5/6" />
              </div>
            ) : latestRevision ? (
              <div className="prose prose-sm dark:prose-invert max-w-none">
                <MarkdownRenderer>
                  {latestRevision.content.replace(/^---\n[\s\S]*?\n---\n*/, "")}
                </MarkdownRenderer>
              </div>
            ) : (
              <div className="text-center py-12 text-muted-foreground text-sm">
                No revisions yet. Click <strong>Resolve</strong> to fetch the SKILL.md from GitHub.
              </div>
            )}
          </CardContent>
        </Card>

        {/* Sidebar: details + revisions */}
        <div className="space-y-4">
          {/* Details */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Details</CardTitle>
            </CardHeader>
            <CardContent className="text-sm space-y-2">
              <div>
                <span className="text-muted-foreground text-xs">Source</span>
                <div className="font-mono text-xs">{skill.source}</div>
              </div>
              <div>
                <span className="text-muted-foreground text-xs">Skill</span>
                <div className="font-mono text-xs">{skill.skillName}</div>
              </div>
              {(latestRevision?.description || skill.description) && (
                <div>
                  <span className="text-muted-foreground text-xs">Description</span>
                  <div className="text-xs">{latestRevision?.description || skill.description}</div>
                </div>
              )}
              {latestRevision?.license && (
                <div>
                  <span className="text-muted-foreground text-xs">License</span>
                  <div className="text-xs">{latestRevision.license}</div>
                </div>
              )}
              {latestRevision?.compatibility && (
                <div>
                  <span className="text-muted-foreground text-xs">Compatibility</span>
                  <div className="text-xs">{latestRevision.compatibility}</div>
                </div>
              )}
              {latestRevision?.allowedTools && (
                <div>
                  <span className="text-muted-foreground text-xs">Allowed Tools</span>
                  <div className="text-xs font-mono">{latestRevision.allowedTools}</div>
                </div>
              )}
              {latestRevision?.metadata && Object.keys(latestRevision.metadata).length > 0 && (
                <div>
                  <span className="text-muted-foreground text-xs">Metadata</span>
                  <div className="text-xs space-y-0.5">
                    {Object.entries(latestRevision.metadata).map(([k, v]) => (
                      <div key={k} className="flex gap-1">
                        <span className="font-mono text-muted-foreground">{k}:</span>
                        <span>{v}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {latestRevision?.validationWarnings && latestRevision.validationWarnings.length > 0 && (
                <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 p-2.5 space-y-1">
                  <span className="text-xs font-medium text-yellow-600 dark:text-yellow-400">⚠ Validation Warnings</span>
                  {latestRevision.validationWarnings.map((w, i) => (
                    <div key={i} className="text-xs text-yellow-700 dark:text-yellow-300">{w}</div>
                  ))}
                </div>
              )}
              <div>
                <span className="text-muted-foreground text-xs">Created</span>
                <div className="text-xs text-muted-foreground">{formatDate(skill.createdAt)}</div>
              </div>
            </CardContent>
          </Card>

          {/* Revisions list */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Revisions</CardTitle>
              <CardDescription className="text-xs">
                Snapshots resolved from GitHub.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loadingRevisions ? (
                <div className="space-y-2">
                  {Array.from({ length: 2 }).map((_, i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </div>
              ) : revisions.length === 0 ? (
                <p className="text-xs text-muted-foreground py-4 text-center">
                  No revisions yet.
                </p>
              ) : (
                <div className="space-y-1">
                  {revisions.map((rev: SkillRevisionDocument, idx: number) => (
                    <div
                      key={rev._id}
                      className={cn(
                        "flex items-center gap-2 rounded-md px-2 py-1.5 text-xs",
                        idx === 0
                          ? "bg-primary/10 border border-primary/20"
                          : "hover:bg-muted",
                      )}
                    >
                      <GitCommit className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="font-mono">{shortCommitHash(rev.commitHash)}</span>
                      <span className="text-muted-foreground ml-auto whitespace-nowrap">
                        {formatDate(rev.resolvedAt)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
