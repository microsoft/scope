// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Trash2, List } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { TaskPromptFeatures } from "@/components/TaskPromptFeatures";
import { Badge } from "@/components/ui/badge";
import { promptTypeLabel } from "@/lib/gates";
import { TaskPromptNameEditor } from "@/components/TaskPromptNameEditor";

export function TaskPromptDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: taskPrompt, isLoading, error } = useQuery({
    queryKey: ["task-prompt", id],
    queryFn: () => api.getTaskPrompt(id!),
    enabled: !!id,
  });

  // Renaming updates both the detail cache and the list.
  const renameMutation = useMutation({
    mutationFn: (name: string | null) => api.renameTaskPrompt(id!, name),
    onSuccess: (updated) => {
      queryClient.setQueryData(["task-prompt", id], updated);
      queryClient.invalidateQueries({ queryKey: ["task-prompts"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteTaskPrompt(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["task-prompts"] });
      navigate("/task-prompts");
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (error || !taskPrompt) {
    return (
      <div className="space-y-4">
        <Link to="/task-prompts" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back to task prompts
        </Link>
        <div className="text-center py-12 text-destructive">
          {error instanceof Error ? error.message : "Task prompt not found"}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Back + header */}
      <div className="flex items-center justify-between">
        <Link to="/task-prompts" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back to task prompts
        </Link>
        <div className="flex items-center gap-2">
          <Link to={`/runs?taskPromptId=${encodeURIComponent(taskPrompt._id)}`}>
            <Button variant="outline" className="gap-1.5">
              <List className="h-4 w-4" /> View Runs
            </Button>
          </Link>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="sm" className="gap-1.5">
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete task prompt?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will soft-delete this task prompt. Existing runs referencing it will not be affected.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => deleteMutation.mutate()}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* Identity card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            {taskPrompt.name ?? `${promptTypeLabel(taskPrompt.type)} Prompt`}
          </CardTitle>
          <CardDescription className="font-mono text-xs select-all">
            {taskPrompt._id}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <span className="text-sm font-medium text-muted-foreground">Name</span>
            <TaskPromptNameEditor name={taskPrompt.name} onSave={(name) => renameMutation.mutateAsync(name)} />
          </div>
          <div className="space-y-1">
            <span className="text-sm font-medium text-muted-foreground">Type</span>
            <div>
              <Badge variant="secondary">{promptTypeLabel(taskPrompt.type)}</Badge>
            </div>
          </div>
          <div className="space-y-1">
            <span className="text-sm font-medium text-muted-foreground">Created</span>
            <p className="text-sm">{formatDate(taskPrompt.createdAt)}</p>
          </div>
          {taskPrompt.deletedAt && (
            <div className="space-y-1">
              <span className="text-sm font-medium text-destructive">Deleted</span>
              <p className="text-sm">{formatDate(taskPrompt.deletedAt)}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Task text card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Prompt Text</CardTitle>
          <CardDescription>Immutable — content determines the ID</CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="whitespace-pre-wrap text-sm bg-muted p-4 rounded-md font-mono leading-relaxed max-h-[400px] overflow-y-auto">
            {taskPrompt.text}
          </pre>
        </CardContent>
      </Card>

      {/* Features */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Prompt Features</CardTitle>
        </CardHeader>
        <CardContent>
          <TaskPromptFeatures taskPromptId={taskPrompt._id} autoExtract />
        </CardContent>
      </Card>
    </div>
  );
}
