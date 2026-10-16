// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type {
  McpServerDocument,
  McpTransportType,
  McpServerHeader,
  McpSessionMode,
} from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2, Loader2, ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { SecretInput } from "@/components/ui/secret-input";

const SLUG_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** Convert a display name to a kebab-case slug */
function nameToSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Convert a kebab-case slug to a Title Case display name */
function slugToName(slug: string): string {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

interface McpServerFormProps {
  onCreated: (server: McpServerDocument) => void;
  onCancel?: () => void;
  className?: string;
  showCancel?: boolean;
  stickyFooter?: boolean;
}

export function McpServerForm({
  onCreated,
  onCancel,
  className,
  showCancel = true,
  stickyFooter = false,
}: McpServerFormProps) {
  const queryClient = useQueryClient();

  // Load the active project's servers so we can flag a duplicate slug before submit.
  // (The list is project-scoped; the API is the source of truth and also 409s.)
  const { data: existingServers = [] } = useQuery({
    queryKey: ["mcp-servers"],
    queryFn: () => api.listMcpServers(),
  });

  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  const [nameManuallyEdited, setNameManuallyEdited] = useState(false);
  const [type, setType] = useState<McpTransportType>("http");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [envPairs, setEnvPairs] = useState<McpServerHeader[]>([]);
  const [sessionMode, setSessionMode] = useState<McpSessionMode>("stateless");
  const [version, setVersion] = useState("");
  const [description, setDescription] = useState("");
  const [headers, setHeaders] = useState<McpServerHeader[]>([]);

  const isStdio = type === "stdio";

  const handleNameChange = (value: string) => {
    setName(value);
    setNameManuallyEdited(true);
    if (!slugManuallyEdited) {
      setSlug(nameToSlug(value));
    }
  };

  const handleSlugChange = (value: string) => {
    const lower = value.toLowerCase();
    setSlug(lower);
    setSlugManuallyEdited(true);
    if (!nameManuallyEdited) {
      setName(slugToName(lower));
    }
  };

  const createMutation = useMutation({
    mutationFn: api.createMcpServer,
    onSuccess: (data) => {
      toast.success(`MCP server "${data.name}" created`);
      // Seed the shared list so pickers can select the new server immediately,
      // then refetch to pick up any server-side normalization.
      queryClient.setQueryData<McpServerDocument[]>(["mcp-servers"], (previous) => {
        const existing = previous ?? [];
        if (existing.some((item) => item._id === data._id)) {
          return existing.map((item) => (item._id === data._id ? data : item));
        }
        return [data, ...existing];
      });
      void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      onCreated(data);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to create MCP server");
    },
  });

  // A server's slug must be unique within the project. The list only holds active
  // servers, so this catches active collisions instantly; soft-deleted collisions are
  // caught by the API's 409 (surfaced via the mutation's onError toast).
  const slugExists = existingServers.some((s) => s._id === slug);
  const isValid = slug && SLUG_REGEX.test(slug) && !slugExists && name && (isStdio ? !!command : !!url);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // React propagates synthetic events through portals, so without this a submit
    // from the inline dialog would also fire an enclosing page form (e.g. Submit Run).
    e.stopPropagation();
    if (!isValid) return;

    if (isStdio) {
      createMutation.mutate({
        _id: slug,
        name,
        type,
        command,
        args: args.trim() ? args.trim().split(/\s+/) : undefined,
        env: envPairs.length > 0 ? Object.fromEntries(envPairs.filter(p => p.name && p.value).map(p => [p.name, p.value])) : undefined,
        sessionMode,
        version: version.trim() || undefined,
        ...(description ? { description } : {}),
      });
    } else {
      createMutation.mutate({
        _id: slug,
        name,
        type,
        url,
        ...(description ? { description } : {}),
        ...(headers.length > 0 ? { headers: headers.filter(h => h.name && h.value) } : {}),
      });
    }
  };

  const addHeader = () => {
    setHeaders([...headers, { name: "", value: "" }]);
  };

  const updateHeader = (index: number, field: "name" | "value", val: string) => {
    const updated = [...headers];
    updated[index] = { ...updated[index], [field]: val };
    setHeaders(updated);
  };

  const removeHeader = (index: number) => {
    setHeaders(headers.filter((_, i) => i !== index));
  };

  const addEnvPair = () => setEnvPairs([...envPairs, { name: "", value: "" }]);
  const updateEnvPair = (index: number, field: "name" | "value", val: string) => {
    const updated = [...envPairs];
    updated[index] = { ...updated[index], [field]: val };
    setEnvPairs(updated);
  };
  const removeEnvPair = (index: number) => setEnvPairs(envPairs.filter((_, i) => i !== index));

  return (
    <form onSubmit={handleSubmit} className={className ? `space-y-6 ${className}` : "space-y-6"}>
      <Card>
        <CardHeader>
          <CardTitle>Server Details</CardTitle>
          <CardDescription>Configure the remote MCP server connection</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="slug">Slug (ID) *</Label>
              <Input
                id="slug"
                placeholder="e.g., my-search-server"
                value={slug}
                onChange={(e) => handleSlugChange(e.target.value)}
                pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                Lowercase letters, numbers, and hyphens only
              </p>
              {slug && !SLUG_REGEX.test(slug) && (
                <p className="text-xs text-destructive">
                  Invalid slug format
                </p>
              )}
              {slug && SLUG_REGEX.test(slug) && slugExists && (
                <p className="text-xs text-destructive">
                  An MCP server with this slug already exists in this project. Use the edit flow to change it.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="name">Name *</Label>
              <Input
                id="name"
                placeholder="e.g., My Search Server"
                value={name}
                onChange={(e) => handleNameChange(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-[10rem_1fr] gap-4">
            <div className="space-y-2">
              <Label htmlFor="type">Transport Type *</Label>
              <Select value={type} onValueChange={(v) => setType(v as McpTransportType)}>
                <SelectTrigger id="type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="http">HTTP (Streamable)</SelectItem>
                  <SelectItem value="sse">SSE</SelectItem>
                  <SelectItem value="stdio">stdio</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {!isStdio ? (
              <div className="space-y-2">
                <Label htmlFor="url">URL *</Label>
                <Input
                  id="url"
                  type="url"
                  placeholder="https://example.com/mcp"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  className="font-mono text-sm"
                />
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="command">Command *</Label>
                <Input
                  id="command"
                  placeholder="e.g., npx"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  className="font-mono text-sm"
                />
              </div>
            )}
          </div>

          {isStdio && (
            <>
              <div className="space-y-2">
                <Label htmlFor="args">Arguments</Label>
                <Input
                  id="args"
                  placeholder="e.g., -y @modelcontextprotocol/server-filesystem /workspace"
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  className="font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground">Space-separated arguments</p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="version">Version pin</Label>
                  <Input
                    id="version"
                    placeholder="e.g., 2026.1.14"
                    value={version}
                    onChange={(e) => setVersion(e.target.value)}
                    className="font-mono text-sm"
                  />
                  <p className="text-xs text-muted-foreground">Pins npm package version</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="sessionMode">Session Mode</Label>
                  <Select value={sessionMode} onValueChange={(v) => setSessionMode(v as McpSessionMode)}>
                    <SelectTrigger id="sessionMode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="stateful">Stateful (stdio default)</SelectItem>
                      <SelectItem value="stateless">Stateless</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </>
          )}

          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              placeholder="Optional description of what this MCP server provides"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </div>
        </CardContent>
      </Card>

      {/* Headers (http/sse only) */}
      {!isStdio && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Headers</CardTitle>
                <CardDescription>Optional HTTP headers sent with every request (e.g., Authorization)</CardDescription>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={addHeader} className="gap-1">
                <Plus className="h-3.5 w-3.5" /> Add Header
              </Button>
            </div>
          </CardHeader>
          {headers.length > 0 && (
            <CardContent className="space-y-3">
              {headers.map((header, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <Input
                    placeholder="Header name"
                    value={header.name}
                    onChange={(e) => updateHeader(idx, "name", e.target.value)}
                    className="font-mono text-sm w-1/3 shrink-0"
                  />
                  <SecretInput
                    placeholder="Header value"
                    value={header.value}
                    onChange={(e) => updateHeader(idx, "value", e.target.value)}
                    containerClassName="flex-1"
                    className="font-mono text-sm"
                  />
                  <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-destructive" onClick={() => removeHeader(idx)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </CardContent>
          )}
        </Card>
      )}

      {/* Environment variables (stdio only) */}
      {isStdio && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Environment Variables</CardTitle>
                <CardDescription>Optional env vars passed to the stdio subprocess</CardDescription>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={addEnvPair} className="gap-1">
                <Plus className="h-3.5 w-3.5" /> Add Variable
              </Button>
            </div>
          </CardHeader>
          {envPairs.length > 0 && (
            <CardContent className="space-y-3">
              {envPairs.map((pair, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <Input
                    placeholder="KEY"
                    value={pair.name}
                    onChange={(e) => updateEnvPair(idx, "name", e.target.value)}
                    className="font-mono text-sm w-1/3 shrink-0"
                  />
                  <SecretInput
                    placeholder="value"
                    value={pair.value}
                    onChange={(e) => updateEnvPair(idx, "value", e.target.value)}
                    containerClassName="flex-1"
                    className="font-mono text-sm"
                  />
                  <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-destructive" onClick={() => removeEnvPair(idx)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </CardContent>
          )}
        </Card>
      )}

      <div
        className={
          stickyFooter
            ? "sticky bottom-0 -mx-6 mt-6 flex justify-end gap-2 border-t bg-background/95 px-6 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80"
            : "flex justify-end gap-2"
        }
      >
        {showCancel && onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Cancel
          </Button>
        )}
        <Button
          type="submit"
          data-command-enter
          disabled={!isValid || createMutation.isPending}
          className="gap-1.5"
        >
          {createMutation.isPending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Creating…
            </>
          ) : (
            "Create Server"
          )}
        </Button>
      </div>
    </form>
  );
}
