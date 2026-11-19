// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { CodebaseRevisionDocument } from "@/types";
import { Button } from "@/components/ui/button";
import { ArtifactDownloadButton } from "@/components/ArtifactDownloadButton";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ArrowLeft, Trash2, RefreshCw, Loader2, FolderGit2, GitCommit, Upload,
  FileArchive, ExternalLink, Download,
} from "lucide-react";
import { formatDate } from "@/lib/utils";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { MAX_ARCHIVE_UPLOAD_LABEL, validateArchiveFile } from "@/lib/codebaseUpload";

export function CodebaseDetail() {
  const { id, revisionId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [refDialogOpen, setRefDialogOpen] = useState(false);
  const [requestedRef, setRequestedRef] = useState("");

  const { data: codebase, isLoading, error } = useQuery({
    queryKey: ["codebase", id],
    queryFn: () => api.getCodebase(id!),
    enabled: !!id,
  });

  const { data: revisions = [], isLoading: loadingRevisions } = useQuery({
    queryKey: ["codebase-revisions", id],
    queryFn: () => api.listCodebaseRevisions(id!, 50),
    enabled: !!id,
  });

  const latestRevision = revisions[0] ?? null;
  const revisionInList = revisionId ? revisions.find((r) => r._id === revisionId) ?? null : null;

  // Deep links may target a revision outside the fetched window; fetch it on demand.
  const { data: fetchedRevision } = useQuery({
    queryKey: ["codebase-revision", revisionId],
    queryFn: () => api.getCodebaseRevision(revisionId!),
    enabled: !!revisionId && !revisionInList && !loadingRevisions,
  });

  const selectedRevision = revisionId
    ? revisionInList ?? fetchedRevision ?? null
    : latestRevision;

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteCodebase(id!),
    onSuccess: () => {
      toast.success("Codebase deleted");
      navigate("/codebases");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to delete codebase"),
  });

  const resolveMutation = useMutation({
    mutationFn: (ref?: string) => api.resolveCodebaseRevision(id!, ref),
    onSuccess: (revision) => {
      queryClient.invalidateQueries({ queryKey: ["codebase", id] });
      queryClient.invalidateQueries({ queryKey: ["codebase-revisions", id] });
      if (revision.deduplicated) {
        toast.info(`No changes — reused existing revision ${revision.ref}`);
      } else {
        toast.success(`Resolved ${revision.ref}`);
      }
      setRefDialogOpen(false);
      setRequestedRef("");
      navigate(`/codebases/${id}`);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to resolve codebase"),
  });

  const uploadMutation = useMutation({
    mutationFn: (file: File) => api.uploadCodebaseArchive(id!, file),
    onSuccess: (revision) => {
      queryClient.invalidateQueries({ queryKey: ["codebase", id] });
      queryClient.invalidateQueries({ queryKey: ["codebase-revisions", id] });
      if (revision.deduplicated) {
        toast.info(`Identical archive — reused existing revision ${revision.ref}, no new revision created`);
      } else {
        toast.success(`Uploaded ${revision.ref}`);
      }
      if (fileInputRef.current) fileInputRef.current.value = "";
      navigate(`/codebases/${id}`);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to upload archive"),
  });

  const selectRevision = (revision: CodebaseRevisionDocument) => {
    if (revision._id === latestRevision?._id) navigate(`/codebases/${id}`);
    else navigate(`/codebases/${id}/revisions/${revision._id}`);
  };

  if (isLoading) {
    return <div className="space-y-4"><Skeleton className="h-8 w-48" /><Skeleton className="h-64 w-full" /></div>;
  }

  if (error || !codebase) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" className="gap-1.5" onClick={() => navigate("/codebases")}><ArrowLeft className="h-4 w-4" /> Back to Codebases</Button>
        <div className="py-12 text-center text-muted-foreground">Codebase not found</div>
      </div>
    );
  }

  const isGit = codebase.sourceType === "git";

  return (
    <div className="space-y-4">
      <Button variant="ghost" className="gap-1.5" onClick={() => navigate("/codebases")}><ArrowLeft className="h-4 w-4" /> Back to Codebases</Button>

      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <FolderGit2 className="h-6 w-6" />
            <h1 className="text-2xl font-bold tracking-tight">{codebase.name}</h1>
            <Badge variant="outline" className="text-xs">{codebase.sourceType}</Badge>
          </div>
          <div className="mt-1 flex items-center gap-3">
            <p className="font-mono text-sm text-muted-foreground">{codebase.slug}</p>
            {codebase.source && (
              <a href={`https://github.com/${codebase.source}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                <ExternalLink className="h-3 w-3" /> GitHub
              </a>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isGit ? (
            <>
              <Button onClick={() => resolveMutation.mutate(undefined)} disabled={resolveMutation.isPending} variant="outline" className="gap-1.5">
                {resolveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Resolve latest
              </Button>
              <Button onClick={() => setRefDialogOpen(true)} disabled={resolveMutation.isPending} variant="outline" className="gap-1.5">
                <GitCommit className="h-4 w-4" /> Resolve ref…
              </Button>
            </>
          ) : (
            <>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                accept=".zip,.tar,.tgz,.tar.gz,.gz"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  const error = validateArchiveFile(file);
                  if (error) {
                    toast.error(error);
                    return;
                  }
                  uploadMutation.mutate(file);
                }}
              />
              <div className="flex flex-col items-end gap-0.5">
                <Button onClick={() => fileInputRef.current?.click()} disabled={uploadMutation.isPending} variant="outline" className="gap-1.5">
                  {uploadMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                  Upload new revision
                </Button>
                <span className="text-[11px] text-muted-foreground">Creates a new revision · max {MAX_ARCHIVE_UPLOAD_LABEL}</span>
              </div>
            </>
          )}
          <AlertDialog>
            <AlertDialogTrigger asChild><Button variant="destructive" size="icon"><Trash2 className="h-4 w-4" /></Button></AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete codebase?</AlertDialogTitle>
                <AlertDialogDescription>This deletes the codebase &quot;{codebase.name}&quot;. Existing runs keep their resolved revision.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => deleteMutation.mutate()}>Delete</AlertDialogAction></AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* Main layout: selected revision + sidebar */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_20rem]">
        {/* Selected revision */}
        <Card className="min-w-0">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <CardTitle className="flex items-center gap-2 text-base">
                  {isGit ? <GitCommit className="h-4 w-4 shrink-0" /> : <FileArchive className="h-4 w-4 shrink-0" />}
                  <span className="truncate font-mono">{selectedRevision?.ref ?? "No revision"}</span>
                  {selectedRevision && selectedRevision._id === latestRevision?._id && <Badge variant="secondary" className="text-[10px]">latest</Badge>}
                </CardTitle>
                <CardDescription>Immutable snapshot seeded into a run workspace.</CardDescription>
              </div>
              {selectedRevision && (
                <ArtifactDownloadButton variant="outline" size="sm" className="gap-1.5"
                  url={`/api/v1/codebase-revisions/${selectedRevision._id}/archive`}
                  filename={`${selectedRevision.ref.replace(/[^a-zA-Z0-9_.@-]/g, "_")}.tar.gz`}>
                    <Download className="h-4 w-4" /> Download
                </ArtifactDownloadButton>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {loadingRevisions ? (
              <div className="space-y-2"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-1/2" /><Skeleton className="h-4 w-2/3" /></div>
            ) : !selectedRevision ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                {isGit ? "No revisions yet. Resolve latest to snapshot the repository." : "No revisions yet. Upload an archive to create the first snapshot."}
              </div>
            ) : (
              <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                {selectedRevision.requestedRef && <Detail label="Requested ref"><span className="font-mono text-xs">{selectedRevision.requestedRef}</span></Detail>}
                {selectedRevision.resolvedCommitSha && (
                  <Detail label="Commit">
                    {selectedRevision.source ? (
                      <a href={`https://github.com/${selectedRevision.source}/commit/${selectedRevision.resolvedCommitSha}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline">
                        {shortSha(selectedRevision.resolvedCommitSha)} <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : (
                      <span className="font-mono text-xs">{shortSha(selectedRevision.resolvedCommitSha)}</span>
                    )}
                  </Detail>
                )}
                {selectedRevision.commitTimestamp && <Detail label="Commit time"><span className="text-xs text-muted-foreground">{formatDate(selectedRevision.commitTimestamp)}</span></Detail>}
                {selectedRevision.originalFilename && <Detail label="Original filename"><span className="font-mono text-xs">{selectedRevision.originalFilename}</span></Detail>}
                <Detail label="Files"><span className="text-xs">{selectedRevision.fileCount?.toLocaleString() ?? "—"}</span></Detail>
                <Detail label="Size"><span className="text-xs">{formatBytes(selectedRevision.sizeBytes)}</span></Detail>
                <Detail label="Resolved"><span className="text-xs text-muted-foreground">{formatDate(selectedRevision.resolvedAt)}</span></Detail>
                {selectedRevision.creator && <Detail label="Creator"><span className="text-xs">{selectedRevision.creator}</span></Detail>}
                {selectedRevision.contentSha256 && <Detail className="sm:col-span-2" label="Content SHA-256"><span className="break-all font-mono text-xs">{selectedRevision.contentSha256}</span></Detail>}
                <Detail className="sm:col-span-2" label="Archive">
                  <ArtifactDownloadButton url={`/api/v1/codebase-revisions/${selectedRevision._id}/archive`}
                    filename={`${selectedRevision.ref.replace(/[^a-zA-Z0-9_.@-]/g, "_")}.tar.gz`}
                    variant="link" className="h-auto whitespace-normal p-0 break-all font-mono text-xs text-left">
                    {`${window.location.origin}/api/v1/codebase-revisions/${selectedRevision._id}/archive`} <Download className="h-3 w-3 shrink-0" />
                  </ArtifactDownloadButton>
                </Detail>
                <Detail className="sm:col-span-2" label="Revision ID"><span className="break-all font-mono text-xs text-muted-foreground">{selectedRevision._id}</span></Detail>
              </dl>
            )}
          </CardContent>
        </Card>

        {/* Sidebar: details + revisions */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-sm">Details</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Detail label="Source type"><Badge variant="outline" className="text-xs">{codebase.sourceType}</Badge></Detail>
              {codebase.source && (
                <Detail label="Source">
                  <a href={`https://github.com/${codebase.source}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline">
                    {codebase.source} <ExternalLink className="h-3 w-3" />
                  </a>
                </Detail>
              )}
              {codebase.defaultBranch && <Detail label="Default branch"><span className="font-mono text-xs">{codebase.defaultBranch}</span></Detail>}
              {codebase.description && <Detail label="Description"><span className="text-xs">{codebase.description}</span></Detail>}
              <Detail label="Created"><span className="text-xs text-muted-foreground">{formatDate(codebase.createdAt)}</span></Detail>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Revisions</CardTitle>
              <CardDescription className="text-xs">Immutable snapshots. Select one to inspect.</CardDescription>
            </CardHeader>
            <CardContent>
              {loadingRevisions ? (
                <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}</div>
              ) : revisions.length === 0 ? (
                <p className="py-4 text-center text-xs text-muted-foreground">No revisions yet.</p>
              ) : (
                <div className="space-y-1">
                  {revisions.map((revision) => (
                    <button
                      key={revision._id}
                      type="button"
                      onClick={() => selectRevision(revision)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                        revision._id === selectedRevision?._id ? "border border-primary/20 bg-primary/10" : "hover:bg-muted",
                      )}
                    >
                      {isGit ? <GitCommit className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <FileArchive className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                      <span className="font-mono">{revision.ref}</span>
                      {revision._id === latestRevision?._id && <Badge variant="secondary" className="text-[10px]">latest</Badge>}
                      <span className="ml-auto whitespace-nowrap text-muted-foreground">{formatDate(revision.resolvedAt)}</span>
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={refDialogOpen} onOpenChange={setRefDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Resolve git ref</DialogTitle></DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="codebase-ref">Branch, tag, or commit SHA</Label>
            <Input id="codebase-ref" value={requestedRef} onChange={(e) => setRequestedRef(e.target.value)} placeholder={codebase.defaultBranch ?? "main"} className="font-mono" />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRefDialogOpen(false)}>Cancel</Button>
            <Button disabled={!requestedRef.trim() || resolveMutation.isPending} onClick={() => resolveMutation.mutate(requestedRef.trim())}>
              {resolveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Resolve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Detail({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return <div className={className}><span className="text-xs text-muted-foreground">{label}</span><div className="break-all">{children}</div></div>;
}

function shortSha(value?: string): string | undefined {
  return value ? value.slice(0, 12) : undefined;
}

function formatBytes(value?: number): string {
  if (value === undefined) return "—";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let size = value / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && size >= 1024; i += 1) {
    size /= 1024;
    unit = units[i];
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${unit}`;
}
