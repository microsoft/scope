// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { UpdateKeyRequest } from "@/types";
import { KEY_TYPE_LABELS, KEY_CAPABILITY_LABELS, KEY_CAPABILITY_DESCRIPTIONS, ALL_CAPABILITIES } from "@/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Trash2, ShieldCheck, Loader2, Save, Zap, Circle } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { toast } from "sonner";
import { useState, useEffect } from "react";
import { buildKeyUpdateRequest } from "./token-detail-utils";

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "valid": return "default";
    case "invalid":
    case "expired": return "destructive";
    case "error": return "secondary";
    default: return "outline";
  }
}

export function TokenDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: token, isLoading, error } = useQuery({
    queryKey: ["token", id],
    queryFn: () => api.getKey(id!),
    enabled: !!id,
    // Poll every 2s while validation hasn't landed yet
    refetchInterval: (query) => {
      const t = query.state.data;
      return t && t.lastValidationStatus === "unknown" ? 2000 : false;
    },
  });

  const [editing, setEditing] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [expiresAt, setExpiresAt] = useState("");
  const [comment, setComment] = useState("");
  const [foundryModel, setFoundryModel] = useState("");

  useEffect(() => {
    if (token) {
      setEnabled(token.enabled);
      setExpiresAt(token.expiresAt ? new Date(token.expiresAt).toISOString().slice(0, 16) : "");
      setComment(token.comment ?? "");
      setFoundryModel(token.model ?? "");
    }
  }, [token]);

  const updateMutation = useMutation({
    mutationFn: (body: UpdateKeyRequest) => api.updateKey(id!, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["token", id] });
      queryClient.invalidateQueries({ queryKey: ["tokens"] });
      setEditing(false);
      toast.success("Key updated");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteKey(id!),
    onSuccess: () => {
      toast.success("Key deleted");
      navigate("/secrets/keys");
    },
  });

  const validateMutation = useMutation({
    mutationFn: () => api.validateKey(id!),
    onSuccess: (updatedToken) => {
      // Immediately update the cached token with the server response
      queryClient.setQueryData(["token", id], updatedToken);
      queryClient.invalidateQueries({ queryKey: ["tokens"] });
      toast.success(`Validation complete — ${updatedToken.lastValidationStatus}`);
    },
  });

  const handleSave = () => {
    updateMutation.mutate(buildKeyUpdateRequest({
      type: token.type,
      enabled,
      expiresAt,
      comment,
      foundryModel,
    }));
  };

  if (isLoading) {
    return (
      <div className="space-y-4 max-w-2xl">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !token) {
    return (
      <div className="space-y-4 max-w-2xl">
        <Button variant="ghost" className="gap-1.5" onClick={() => navigate("/secrets/keys")}>
          <ArrowLeft className="h-4 w-4" /> Back to Keys
        </Button>
        <div className="text-center py-12 text-muted-foreground">
          Key not found
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Back link */}
      <Button variant="ghost" className="gap-1.5" onClick={() => navigate("/secrets/keys")}>
        <ArrowLeft className="h-4 w-4" /> Back to Keys
      </Button>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight font-mono">{token.secretName}</h1>
          <p className="text-sm text-muted-foreground">
            {KEY_TYPE_LABELS[token.type]}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            className="gap-1.5"
            disabled={validateMutation.isPending}
            onClick={() => validateMutation.mutate()}
          >
            {validateMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ShieldCheck className="h-4 w-4" />
            )}
            Validate
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" className="gap-1.5">
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete key?</AlertDialogTitle>
                <AlertDialogDescription>
                  This soft-deletes the key. The KeyVault secret is preserved and can be restored.
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

      {/* Status card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Validation Status</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3">
            <Badge variant={statusVariant(token.lastValidationStatus)} className="text-sm">
              {token.lastValidationStatus}
            </Badge>
            {token.lastValidatedAt && (
              <span className="text-sm text-muted-foreground">
                Last checked {formatDate(token.lastValidatedAt)}
              </span>
            )}
          </div>
          {token.lastValidationError && (
            <p className="text-sm text-destructive">{token.lastValidationError}</p>
          )}
        </CardContent>
      </Card>

      {/* Capabilities card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Zap className="h-4 w-4" />
            Capabilities
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2">
            {ALL_CAPABILITIES.map((cap) => {
              const active = (token.capabilities ?? []).includes(cap);
              return (
                <div
                  key={cap}
                  className={`flex items-start gap-3 rounded-lg border p-3 transition-colors ${
                    active
                      ? "border-primary/40 bg-primary/5"
                      : "border-muted bg-muted/30 opacity-50"
                  }`}
                >
                  <Circle
                    className={`mt-0.5 h-3 w-3 shrink-0 ${
                      active ? "fill-primary text-primary" : "text-muted-foreground"
                    }`}
                  />
                  <div className="min-w-0">
                    <p className={`text-sm font-medium ${active ? "" : "text-muted-foreground"}`}>
                      {KEY_CAPABILITY_LABELS[cap]}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {KEY_CAPABILITY_DESCRIPTIONS[cap]}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Metadata card */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Metadata</CardTitle>
          {!editing ? (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
          ) : (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button size="sm" className="gap-1" onClick={handleSave} disabled={updateMutation.isPending}>
                {updateMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                Save
              </Button>
            </div>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">ID</span>
              <p className="font-mono">{token._id}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Secret Name</span>
              <p className="font-mono">{token.secretName}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Created</span>
              <p>{formatDate(token.createdAt)}</p>
            </div>
            {token.updatedAt && (
              <div>
                <span className="text-muted-foreground">Updated</span>
                <p>{formatDate(token.updatedAt)}</p>
              </div>
            )}
            <div>
              <span className="text-muted-foreground">Acquired</span>
              <p>{(token.acquireCount ?? 0).toLocaleString()} times</p>
            </div>
            {token.lastAcquiredAt && (
              <div>
                <span className="text-muted-foreground">Last Acquired</span>
                <p>{formatDate(token.lastAcquiredAt)}</p>
              </div>
            )}
          </div>

          <Separator />

          {/* Editable fields */}
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Comment</Label>
              {editing ? (
                <Textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="e.g. John's CI key"
                  maxLength={500}
                  rows={2}
                />
              ) : (
                <p className="text-sm">
                  {token.comment || <span className="text-muted-foreground">No comment</span>}
                </p>
              )}
            </div>
            <div className="flex items-center gap-3">
              <Label>Enabled</Label>
              {editing ? (
                <Button
                  variant={enabled ? "default" : "secondary"}
                  size="sm"
                  onClick={() => setEnabled(!enabled)}
                >
                  {enabled ? "Yes" : "No"}
                </Button>
              ) : (
                <Badge variant={token.enabled ? "default" : "secondary"}>
                  {token.enabled ? "Yes" : "No"}
                </Badge>
              )}
            </div>
            <div className="space-y-1">
              <Label>Expires At</Label>
              {editing ? (
                <Input
                  type="datetime-local"
                  value={expiresAt}
                  onChange={(e) => setExpiresAt(e.target.value)}
                />
              ) : (
                <p className="text-sm">
                  {token.expiresAt ? formatDate(token.expiresAt) : "No expiration"}
                </p>
              )}
            </div>
            {token.type === "azure-ai-foundry" && (
              <div className="space-y-1">
                <Label htmlFor="foundry-model">Deployment / Model name</Label>
                {editing ? (
                  <>
                    <Input
                      id="foundry-model"
                      value={foundryModel}
                      onChange={(e) => setFoundryModel(e.target.value)}
                      placeholder="e.g. gpt-4.1-mini"
                    />
                    <p className="text-xs text-muted-foreground">
                      Clear this field to use the default model.
                    </p>
                  </>
                ) : (
                  <p className="text-sm">
                    {token.model || (
                      <span className="text-muted-foreground">Provider default</span>
                    )}
                  </p>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
