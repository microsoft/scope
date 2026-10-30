// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  Copy,
  History,
  Network,
  Pencil,
  Trash2,
} from "lucide-react";
import { api } from "@/lib/api";
import type {
  ResolvedTaxonomyElement,
} from "@/types";
import { cn, formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { DataTable, type DataTableColumn } from "@/components/list-layout";
import { toast } from "sonner";

/** Exact taxonomy revision detail with ordered resolved element revisions. */
export function TaxonomyDetail({
  taxonomyId: taxonomyIdOverride,
  revisionId: revisionIdOverride,
}: {
  taxonomyId?: string;
  revisionId?: string;
} = {}) {
  const { taxonomyId: routeTaxonomyId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const taxonomyId = taxonomyIdOverride ?? routeTaxonomyId;
  const revisionId =
    revisionIdOverride ?? searchParams.get("revision") ?? undefined;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [editing, setEditing] = useState<ResolvedTaxonomyElement>();
  const [prompt, setPrompt] = useState("");

  const detailQuery = useQuery({
    queryKey: ["taxonomy-detail", taxonomyId, revisionId ?? "latest"],
    queryFn: () => api.getTaxonomyDetail(taxonomyId!, revisionId),
    enabled: Boolean(taxonomyId),
  });
  const detail = detailQuery.data;
  const isHistorical = Boolean(
    detail &&
    detail.selectedRevision._id !== detail.taxonomy.latestRevisionId,
  );

  const remove = useMutation({
    mutationFn: () => api.deleteTaxonomy(taxonomyId!),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["taxonomies"] });
      toast.success("Taxonomy deleted");
      navigate("/taxonomies");
    },
    onError: mutationError =>
      toast.error(
        mutationError instanceof Error
          ? mutationError.message
          : "Deletion failed",
      ),
  });
  const copy = useMutation({
    mutationFn: async () => {
      if (!detail) throw new Error("Taxonomy detail is not loaded");
      return api.copyTaxonomyRevision(detail.selectedRevision._id, {
        name: `${detail.taxonomy.name} copy`,
        id: `${detail.taxonomy.id}-copy`,
      });
    },
    onSuccess: created => {
      void queryClient.invalidateQueries({ queryKey: ["taxonomies"] });
      toast.success("Built-in taxonomy copied");
      navigate(`/taxonomies/${created._id}`);
    },
    onError: mutationError =>
      toast.error(
        mutationError instanceof Error ? mutationError.message : "Copy failed",
      ),
  });
  const revisePrompt = useMutation({
    mutationFn: async () => {
      if (!detail || !editing) throw new Error("No prompt element selected");
      if (editing.revision.implementation.type !== "prompt") {
        throw new Error("Deterministic elements are read-only");
      }
      const elementRevision = await api.createTaxonomyElementRevision(
        editing.root._id,
        {
          schema_version: editing.revision.schema_version,
          id: editing.revision.id,
          label: editing.revision.label,
          ...(editing.revision.description
            ? { description: editing.revision.description }
            : {}),
          ...(editing.revision.category_id
            ? { category_id: editing.revision.category_id }
            : {}),
          implementation: { type: "prompt", prompt },
          preconditions: editing.revision.preconditions,
          output: editing.revision.output,
        },
      );
      return api.createTaxonomyRevision(detail.taxonomy._id, {
        schema_version: detail.selectedRevision.schema_version,
        id: detail.selectedRevision.id,
        version: detail.selectedRevision.version,
        surfaces: detail.selectedRevision.surfaces,
        elements: detail.selectedRevision.elements.map(reference =>
          "ref" in reference && reference.ref === editing.revision.ref
            ? { ref: elementRevision.ref }
            : reference
        ),
      });
    },
    onSuccess: revision => {
      setEditing(undefined);
      setPrompt("");
      void queryClient.invalidateQueries({ queryKey: ["taxonomies"] });
      void queryClient.invalidateQueries({
        queryKey: ["taxonomy-detail", taxonomyId],
      });
      void queryClient.invalidateQueries({ queryKey: ["taxonomy-elements"] });
      setSearchParams({});
      toast.success(`Prompt updated in ${revision.ref}`);
    },
    onError: mutationError =>
      toast.error(
        mutationError instanceof Error
          ? mutationError.message
          : "Prompt update failed",
      ),
  });

  const columns = useMemo<DataTableColumn<ResolvedTaxonomyElement>[]>(() => [
    {
      id: "position",
      header: "#",
      width: "48px",
      cell: element => (
        <span className="font-mono text-xs text-muted-foreground">
          {element.position + 1}
        </span>
      ),
      hiddenOnCard: true,
    },
    {
      id: "label",
      header: "Element",
      cell: element => (
        <div className="min-w-0">
          <p className="font-medium">{element.revision.label}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {element.revision.ref}
          </p>
        </div>
      ),
    },
    {
      id: "implementation",
      header: "Implementation",
      width: "140px",
      cell: element => (
        <Badge variant="outline">
          {element.revision.implementation.type === "prompt"
            ? "Prompt"
            : "Deterministic"}
        </Badge>
      ),
    },
    {
      id: "source",
      header: "Source",
      width: "150px",
      cell: element => (
        <Badge
          variant={element.root.sourceType === "builtin" ? "secondary" : "outline"}
        >
          {element.root.sourceType === "builtin"
            ? "Built-in · read-only"
            : element.root.deletedAt ? "User · deleted" : "User"}
        </Badge>
      ),
    },
    {
      id: "description",
      header: "Description / category",
      cell: element => (
        <div className="max-w-md text-xs">
          <p>{element.revision.description ?? "—"}</p>
          {element.revision.category_id && (
            <p className="mt-1 font-mono text-muted-foreground">
              {element.revision.category_id}
            </p>
          )}
        </div>
      ),
    },
    {
      id: "revision",
      header: "Exact revision",
      width: "110px",
      cell: element => (
        <span className="font-mono text-xs">r{element.revision.revision}</span>
      ),
    },
    {
      id: "actions",
      header: "",
      width: "96px",
      align: "right",
      cell: element => {
        const editable =
          !isHistorical &&
          !detail?.taxonomy.deletedAt &&
          element.root.sourceType === "user" &&
          !element.root.deletedAt &&
          element.revision.implementation.type === "prompt";
        return editable ? (
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={event => {
              event.stopPropagation();
              setEditing(element);
              setPrompt(
                element.revision.implementation.type === "prompt"
                  ? element.revision.implementation.prompt
                  : "",
              );
            }}
          >
            <Pencil className="h-3.5 w-3.5" /> Edit prompt
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">Read-only</span>
        );
      },
    },
  ], [detail?.taxonomy.deletedAt, isHistorical]);

  if (detailQuery.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  if (detailQuery.error || !detail) {
    return (
      <div className="space-y-4">
        <Button
          variant="ghost"
          className="gap-1.5"
          onClick={() => navigate("/taxonomies")}
        >
          <ArrowLeft className="h-4 w-4" /> Back to Taxonomies
        </Button>
        <div className="py-16 text-center">
          <h1 className="text-xl font-semibold">Taxonomy not found</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            It may be deleted, outside the active project, or the selected
            revision may not exist.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Button
        variant="ghost"
        className="gap-1.5"
        onClick={() => navigate("/taxonomies")}
      >
        <ArrowLeft className="h-4 w-4" /> Back to Taxonomies
      </Button>

      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Network className="h-6 w-6" />
            <h1 className="truncate text-2xl font-bold tracking-tight">
              {detail.taxonomy.name}
            </h1>
            <Badge
              variant={
                detail.taxonomy.sourceType === "builtin"
                  ? "secondary"
                  : "outline"
              }
            >
              {detail.taxonomy.sourceType === "builtin"
                ? "Built-in · read-only"
                : "User"}
            </Badge>
            {isHistorical && <Badge variant="outline">Historical</Badge>}
            {detail.taxonomy.deletedAt && (
              <Badge variant="destructive">Deleted</Badge>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
            <span className="font-mono">{detail.selectedRevision.ref}</span>
            <span className="text-muted-foreground">
              semantic version {detail.selectedRevision.version}
            </span>
            <span className="text-muted-foreground">
              {detail.elements.length} element
              {detail.elements.length === 1 ? "" : "s"}
            </span>
          </div>
          {detail.taxonomy.description && (
            <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
              {detail.taxonomy.description}
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          {detail.taxonomy.sourceType === "builtin" ? (
            <Button
              variant="outline"
              className="gap-1.5"
              disabled={copy.isPending}
              onClick={() => copy.mutate()}
            >
              <Copy className="h-4 w-4" /> Copy this revision
            </Button>
          ) : (
            <Button
              variant="outline"
              className="gap-1.5 text-destructive"
              disabled={Boolean(detail.taxonomy.deletedAt)}
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="h-4 w-4" /> Delete
            </Button>
          )}
        </div>
      </header>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Taxonomy elements</CardTitle>
            <CardDescription>
              Exact element revisions referenced by {detail.selectedRevision.ref},
              in authored order. Unrelated project elements are not included.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable
              items={detail.elements}
              columns={columns}
              getRowId={element => `${element.position}:${element.revision._id}`}
              emptyState="This taxonomy revision does not reference any elements."
              density="compact"
            />
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Revision identity</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Detail label="Exact ref">{detail.selectedRevision.ref}</Detail>
              <Detail label="Semantic version">
                {detail.selectedRevision.version}
              </Detail>
              <Detail label="Content SHA-256">
                <span className="break-all font-mono text-xs">
                  {detail.selectedRevision.contentSha256}
                </span>
              </Detail>
              <Detail label="Created">
                {formatDate(detail.selectedRevision.createdAt)}
              </Detail>
              {detail.taxonomy.updatedAt && (
                <Detail label="Root updated">
                  {formatDate(detail.taxonomy.updatedAt)}
                </Detail>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <History className="h-4 w-4" /> Revision history
              </CardTitle>
              <CardDescription className="text-xs">
                Selecting a historical revision resolves its exact element-ref
                vector.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-1">
                {detail.revisions.map(revision => (
                  <button
                    key={revision._id}
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs transition-colors",
                      revision._id === detail.selectedRevision._id
                        ? "border border-primary/20 bg-primary/10"
                        : "hover:bg-muted",
                    )}
                    onClick={() => {
                      if (revision.isLatest) setSearchParams({});
                      else setSearchParams({ revision: revision._id });
                    }}
                  >
                    <span className="font-mono">{revision.ref}</span>
                    {revision.isLatest && (
                      <Badge variant="secondary" className="text-[10px]">
                        latest
                      </Badge>
                    )}
                    <span className="ml-auto whitespace-nowrap text-muted-foreground">
                      {revision.elementCount} element
                      {revision.elementCount === 1 ? "" : "s"}
                    </span>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog
        open={Boolean(editing)}
        onOpenChange={open => {
          if (!open) {
            setEditing(undefined);
            setPrompt("");
          }
        }}
      >
        <DialogContent className="grid max-h-[85vh] max-w-3xl grid-rows-[auto_minmax(0,1fr)]">
          <DialogHeader>
            <DialogTitle>Edit {editing?.revision.label} prompt</DialogTitle>
            <DialogDescription>
              Creates a new element revision and taxonomy revision while
              preserving prior exact refs.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 space-y-3 overflow-y-auto">
            <p className="text-sm text-muted-foreground">
              Creates a new element revision and a new taxonomy revision that
              pins it. Prior revisions remain unchanged.
            </p>
            <Textarea
              aria-label="Prompt instruction"
              className="min-h-80 font-mono text-xs"
              value={prompt}
              onChange={event => setPrompt(event.target.value)}
            />
            <div className="sticky bottom-0 flex justify-end border-t bg-background py-3">
              <Button
                disabled={!prompt.trim() || revisePrompt.isPending}
                onClick={() => revisePrompt.mutate()}
              >
                Create new revisions
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete taxonomy?</AlertDialogTitle>
            <AlertDialogDescription>
              This soft-deletes &quot;{detail.taxonomy.name}&quot;. Existing
              Experiment revisions retain their exact pinned taxonomy revision.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Detail({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="break-words text-xs">{children}</div>
    </div>
  );
}
