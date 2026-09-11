// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PortalAiSettings as Settings } from "shared";
import type { KeyCapability, KeyDocument } from "@/types";
import { apiClient } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const PROVIDERS: Record<Settings["provider"], { label: string; capability?: KeyCapability }> = {
  auto: { label: "Automatic (Foundry → GitHub Models)" },
  "azure-ai-foundry": { label: "Azure AI Foundry", capability: "azure-ai-inference" },
  "github-models": { label: "GitHub Models", capability: "github-models" },
  anthropic: { label: "Anthropic", capability: "anthropic-api" },
  openai: { label: "OpenAI", capability: "openai-api" },
  openrouter: { label: "OpenRouter", capability: "openrouter-api" },
  "openai-compatible": { label: "OpenAI-compatible", capability: "openai-compatible" },
};

async function settingsRequest(settings?: Settings): Promise<Settings> {
  const response = await apiClient("/api/v1/keys/portal-ai", {
    method: settings ? "PUT" : "GET", ...(settings ? { json: settings } : {}),
  });
  if (!response.ok) {
    const body: { error?: string } = await response.json();
    throw new Error(body.error || `Portal AI settings request failed (${response.status})`);
  }
  return response.json<Settings>();
}

export function PortalAiSettings({ keys }: { keys: KeyDocument[] }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Settings | null>(null);
  const query = useQuery({ queryKey: ["portal-ai-settings"], queryFn: () => settingsRequest(), retry: false });
  const save = useMutation({
    mutationFn: settingsRequest,
    onSuccess: (saved) => {
      queryClient.setQueryData(["portal-ai-settings"], saved);
      setDraft(null);
    },
  });
  const selection = draft ?? query.data ?? { provider: "auto" };
  const capability = PROVIDERS[selection.provider]?.capability;
  const available = keys.filter((key) => capability && key.capabilities.includes(capability) &&
    key.enabled && !key.deletedAt && key.lastValidationStatus === "valid" &&
    (!key.expiresAt || new Date(key.expiresAt).getTime() > Date.now()));
  return (
    <section className="border-b px-6 py-3 space-y-3" aria-label="Portal AI settings">
      <div>
        <h2 className="text-sm font-semibold">Portal AI</h2>
        <p className="text-xs text-muted-foreground">
          Provider for criteria, prompt features and task authoring only. Does not change Judge, reports or coding agents.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="portal-ai-provider">Provider</Label>
          <Select disabled={save.isPending} value={selection.provider} onValueChange={(value) => setDraft({ provider: value as Settings["provider"] })}>
            <SelectTrigger id="portal-ai-provider" className="w-72"><SelectValue /></SelectTrigger>
            <SelectContent>
              {Object.entries(PROVIDERS).map(([value, info]) => <SelectItem key={value} value={value}>{info.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        {selection.provider !== "auto" && <>
          <div className="space-y-1">
            <Label htmlFor="portal-ai-key">Credential</Label>
            <Select disabled={save.isPending} value={selection.keyId ?? "round-robin"} onValueChange={(value) =>
              setDraft({ ...selection, keyId: value === "round-robin" ? undefined : value })}>
              <SelectTrigger id="portal-ai-key" className="w-64"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="round-robin">All valid keys for this provider</SelectItem>
                {available.map((key) => <SelectItem key={key._id} value={key._id}>{key.comment || key._id}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="portal-ai-model">Model override (optional)</Label>
            <Input id="portal-ai-model" disabled={save.isPending} value={selection.model ?? ""}
              placeholder={selection.provider === "anthropic" ? "claude-sonnet-4-20250514" : "Use credential model"}
              onChange={(event) => setDraft({ ...selection, model: event.target.value || undefined })} />
          </div>
        </>}
        <Button disabled={!draft || query.isPending || query.isError || save.isPending}
          onClick={() => save.mutate(selection)}>Save Portal AI</Button>
      </div>
      {selection.provider !== "auto" && available.length === 0 &&
        <p role="status" className="text-xs text-amber-600">No valid key for this provider. Register or validate one before using Portal AI.</p>}
      {selection.keyId && !available.some((key) => key._id === selection.keyId) &&
        <p role="status" className="text-xs text-amber-600">The selected credential is unavailable. Choose another credential or restore automatic selection.</p>}
      {selection.provider !== "auto" &&
        <p className="text-xs text-muted-foreground">Only the selected provider is used. Pin a credential when endpoints or models differ. Failures do not switch providers.</p>}
      {(query.error || save.error) && <p role="alert" className="text-sm text-destructive">{(query.error || save.error)?.message}</p>}
      {save.isSuccess && !draft && <p role="status" className="text-xs">Portal AI settings saved.</p>}
    </section>
  );
}
