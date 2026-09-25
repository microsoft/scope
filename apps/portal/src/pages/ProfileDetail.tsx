// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import type { ProfileVersionDocument } from "@/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Edit, Trash2, Clock, Layers, Plus, Zap } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { KbdBadge } from "@/components/KbdBadge";
import { AgentBadge, agentDisplayName, useAgentCatalog } from "@/components/AgentBadge";
import { SkillRevisionLinks } from "@/components/SkillRevisionLinks";
import { toast } from "sonner";

export function ProfileDetail() {
  const { profileId, version: versionParam } = useParams<{ profileId: string; version?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { agentById } = useAgentCatalog();

  const isSpecificVersion = !!versionParam;
  const versionNumber = versionParam ? parseInt(versionParam, 10) : undefined;

  // Inline identity editing state
  const [editingIdentity, setEditingIdentity] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");

  // Fetch profile (with latest version)
  const { data: profile, isLoading: profileLoading } = useQuery({
    queryKey: ["profile", profileId],
    queryFn: () => api.getProfile(profileId!),
    enabled: !!profileId,
  });

  // If viewing a specific version, fetch that version
  const { data: specificVersion } = useQuery({
    queryKey: ["profile-version", profileId, versionNumber],
    queryFn: () => api.getProfileVersion(profileId!, versionNumber!),
    enabled: !!profileId && isSpecificVersion,
  });

  // Fetch all versions for the version history
  const { data: versions = [] } = useQuery({
    queryKey: ["profile-versions", profileId],
    queryFn: () => api.listProfileVersions(profileId!),
    enabled: !!profileId,
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteProfile(profileId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["profiles"] });
      toast.success("Profile deleted");
      navigate("/profiles");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to delete profile");
    },
  });

  const identityMutation = useMutation({
    mutationFn: () => api.updateProfileIdentity(profileId!, {
      name: editName,
      ...(editDescription ? { description: editDescription } : {}),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["profile", profileId] });
      queryClient.invalidateQueries({ queryKey: ["profiles"] });
      setEditingIdentity(false);
      toast.success("Profile updated");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to update profile");
    },
  });

  const startEditingIdentity = () => {
    if (profile) {
      setEditName(profile.name);
      setEditDescription(profile.description ?? "");
      setEditingIdentity(true);
    }
  };

  if (profileLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="space-y-6">
        <Button variant="ghost" onClick={() => navigate("/profiles")}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Back
        </Button>
        <p className="text-muted-foreground">Profile not found.</p>
      </div>
    );
  }

  // Use specific version if viewing one, otherwise latest
  const displayVersion: ProfileVersionDocument | undefined = isSpecificVersion
    ? specificVersion
    : profile.version;

  return (
    <div className="space-y-6">
      {/* Edit Identity Dialog */}
      <Dialog open={editingIdentity} onOpenChange={setEditingIdentity}>
        <DialogContent>
          <DialogHeader>
            <div className="flex items-center justify-between">
              <div>
                <DialogTitle>Edit Profile</DialogTitle>
                <DialogDescription>Update the profile name and description.</DialogDescription>
              </div>
              {displayVersion && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => {
                    const parts: string[] = [];
                    const descParts: string[] = [];
                    const workerId = displayVersion.workerType;
                    if (workerId) {
                      const workerName = agentDisplayName(workerId, agentById);
                      const label = displayVersion.agentVersion
                        ? `${workerName}@${displayVersion.agentVersion}`
                        : workerName;
                      parts.push(label);
                      descParts.push(label);
                    }
                    if (displayVersion.model) {
                      parts.push(displayVersion.model);
                      descParts.push(`model: ${displayVersion.model}`);
                    }
                    if (displayVersion.mcpServers?.length) {
                      parts.push(displayVersion.mcpServers.join(", "));
                      descParts.push(`MCP: ${displayVersion.mcpServers.join(", ")}`);
                    }
                    if (displayVersion.skillRevisions?.length) {
                      const short = displayVersion.skillRevisions.map((s) => s.split("/").pop() ?? s);
                      parts.push(short.join(", "));
                      descParts.push(`Skills: ${displayVersion.skillRevisions.join(", ")}`);
                    }
                    if (displayVersion.extensions?.length) {
                      const short = displayVersion.extensions.map((e) => e.split("/").pop() ?? e);
                      parts.push(short.join(", "));
                      descParts.push(`Extensions: ${displayVersion.extensions.join(", ")}`);
                    }
                    setEditName(parts.join(" + ").slice(0, 128));
                    setEditDescription(descParts.join(". ").slice(0, 512));
                  }}
                >
                  <Zap className="h-3.5 w-3.5" />
                  Auto-fill
                </Button>
              )}
            </div>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="edit-name">Name</Label>
              <Input
                id="edit-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                autoFocus
              />
              {editName.length > 128 && (
                <p className="text-xs text-destructive">Name must be 128 characters or fewer</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-description">Description</Label>
              <Textarea
                id="edit-description"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                placeholder="Optional description"
                rows={3}
              />
              {editDescription.length > 512 && (
                <p className="text-xs text-destructive">Description must be 512 characters or fewer</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingIdentity(false)} disabled={identityMutation.isPending}>
              Cancel
            </Button>
            <Button
              data-command-enter
              className="gap-1.5"
              onClick={() => identityMutation.mutate()}
              disabled={
                !editName.trim() ||
                editName.length > 128 ||
                editDescription.length > 512 ||
                identityMutation.isPending ||
                (editName === profile?.name && editDescription === (profile?.description ?? ""))
              }
            >
              {identityMutation.isPending ? "Saving..." : <>Save <KbdBadge /></>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate("/profiles")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold">{profile.name}</h1>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={startEditingIdentity}>
                <Edit className="h-3.5 w-3.5" />
              </Button>
              {displayVersion && (
                <Badge variant={isSpecificVersion ? "outline" : "secondary"}>
                  v{displayVersion.version}
                  {!isSpecificVersion && " (latest)"}
                </Badge>
              )}
            </div>
            {profile.description && (
              <p className="text-muted-foreground">{profile.description}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => navigate(`/profiles/${profileId}/new-version`)}>
            <Plus className="mr-2 h-4 w-4" /> New Version
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" className="text-destructive">
                <Trash2 className="mr-2 h-4 w-4" /> Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete profile?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will soft-delete "{profile.name}" and all its versions.
                  Existing runs referencing this profile will not be affected.
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

      <div className="grid gap-6 md:grid-cols-3">
        {/* Main content: configuration details */}
        <div className="md:col-span-2 space-y-6">
          {displayVersion ? (
            <Card>
              <CardHeader>
                <CardTitle>Configuration</CardTitle>
                <CardDescription>
                  Version {displayVersion.version} — created{" "}
                  {new Date(displayVersion.createdAt).toLocaleString()}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <FieldLabel>Worker</FieldLabel>
                    <p className="text-sm">
                      <AgentBadge
                        agentId={displayVersion.workerType}
                        version={displayVersion.agentVersion}
                      />
                    </p>
                  </div>
                  <div>
                    <FieldLabel>Model</FieldLabel>
                    <p className="font-mono text-sm">{displayVersion.model}</p>
                  </div>
                  {displayVersion.reasoningEffort && (
                    <div>
                      <FieldLabel>Reasoning Effort</FieldLabel>
                      <p className="font-mono text-sm">{displayVersion.reasoningEffort}</p>
                    </div>
                  )}
                  {displayVersion.agentVersion && (
                    <div>
                      <FieldLabel>Agent Version</FieldLabel>
                      <p className="font-mono text-sm">{displayVersion.agentVersion}</p>
                    </div>
                  )}
                </div>

                {displayVersion.mcpServers && displayVersion.mcpServers.length > 0 && (
                  <>
                    <Separator />
                    <div>
                      <FieldLabel>MCP Servers</FieldLabel>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {displayVersion.mcpServers.map((s) => (
                          <Badge key={s} variant="outline" className="font-mono text-xs">{s}</Badge>
                        ))}
                      </div>
                    </div>
                  </>
                )}

                {displayVersion.skillRevisions && displayVersion.skillRevisions.length > 0 && (
                  <>
                    <Separator />
                    <div>
                      <FieldLabel>Skills</FieldLabel>
                      <div className="mt-1">
                        <SkillRevisionLinks references={displayVersion.skillRevisions} />
                      </div>
                    </div>
                  </>
                )}

                {displayVersion.extensions && displayVersion.extensions.length > 0 && (
                  <>
                    <Separator />
                    <div>
                      <FieldLabel>Extensions</FieldLabel>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {displayVersion.extensions.map((e) => {
                          const at = e.lastIndexOf("@");
                          const id = at > 0 ? e.substring(0, at) : e;
                          const version = at > 0 ? e.substring(at + 1) : undefined;
                          return (
                            <Badge key={e} variant="outline" className="font-mono text-xs gap-1">
                              {id}
                              {version && <span className="text-muted-foreground">@{version}</span>}
                            </Badge>
                          );
                        })}
                      </div>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          ) : (
            <Skeleton className="h-48 w-full" />
          )}
        </div>

        {/* Sidebar: version history */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Layers className="h-4 w-4" /> Version History
              </CardTitle>
              <CardDescription>{versions.length} version{versions.length !== 1 ? "s" : ""}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {versions.map((v: ProfileVersionDocument) => (
                  <button
                    key={v._id}
                    className={`w-full text-left p-2 rounded-md text-sm hover:bg-muted transition-colors ${
                      displayVersion?._id === v._id ? "bg-muted font-medium" : ""
                    }`}
                    onClick={() => navigate(`/profiles/${profileId}/v/${v.version}`)}
                  >
                    <div className="flex items-center justify-between">
                      <span>v{v.version}</span>
                      {v.version === profile.latestVersion && (
                        <Badge variant="secondary" className="text-xs">latest</Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {new Date(v.createdAt).toLocaleString()}
                    </div>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">{children}</p>;
}
