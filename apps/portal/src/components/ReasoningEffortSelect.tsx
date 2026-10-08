// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ModelCapabilities } from "@/types";

// --- Hook: useModelCapabilities ---

export function useModelCapabilities(agentId: string | undefined) {
  const { data: agentModels = [], isSuccess } = useQuery({
    queryKey: ["models", agentId, "active"],
    queryFn: () => api.listModels({ agentId: agentId!, status: "active" }),
    enabled: !!agentId,
  });

  const capabilitiesMap = new Map<string, ModelCapabilities>(
    agentModels
      .filter((m): m is typeof m & { capabilities: ModelCapabilities } => !!m.capabilities)
      .map((m) => [m.modelId, m.capabilities])
  );

  // Sorted list of active model IDs derived from the models collection (source of truth)
  const activeModelIds = agentModels.map((m) => m.modelId).sort();

  return {
    agentModels,
    capabilitiesMap,
    activeModelIds,
    capabilitiesLoaded: !agentId || isSuccess,
  };
}

// --- Hook: useReasoningEffort ---

export interface UseReasoningEffortOptions {
  model: string;
  capabilitiesMap: Map<string, ModelCapabilities>;
  value: string;
  onChange: (value: string) => void;
  /** Whether the selected worker supports reasoning effort (omitted = unsupported) */
  agentSupportsEffort?: boolean;
  /** False while the model registry result is still unknown. */
  capabilitiesLoaded?: boolean;
}

/**
 * Derives supportedEfforts from model capabilities and auto-clears
 * the effort value when the selected model doesn't support it.
 */
export function useReasoningEffort({
  model,
  capabilitiesMap,
  value,
  onChange,
  agentSupportsEffort,
  capabilitiesLoaded = true,
}: UseReasoningEffortOptions) {
  const capabilities = model ? capabilitiesMap.get(model) : undefined;
  const modelEfforts = capabilities?.reasoningEffort ?? [];
  const supportedEfforts = agentSupportsEffort === true ? modelEfforts : [];

  useEffect(() => {
    if (!capabilitiesLoaded) return;
    if (supportedEfforts.length === 1 && value !== supportedEfforts[0]) {
      // Auto-select the only supported effort
      onChange(supportedEfforts[0]);
    } else if (value && !supportedEfforts.includes(value)) {
      onChange("");
    }
  }, [capabilitiesLoaded, model, supportedEfforts, value, onChange]);

  const workerEffortWarning = modelEfforts.length > 0 && agentSupportsEffort === false;

  return { supportedEfforts, capabilities, workerEffortWarning };
}

// --- Component: ModelSelectItems ---

export interface ModelSelectItemsProps {
  models: string[];
  capabilitiesMap: Map<string, ModelCapabilities>;
  defaultModel?: string;
  excludeModel?: string;
}

/**
 * Renders model SelectItems with effort capability badges.
 * Use inside a <SelectContent>.
 */
export function ModelSelectItems({
  models,
  capabilitiesMap,
  defaultModel,
  excludeModel,
}: ModelSelectItemsProps) {
  const filtered = excludeModel
    ? models.filter((m) => m !== excludeModel)
    : models;

   return (
    <>
      {filtered.map((m) => {
        const caps = capabilitiesMap.get(m);
        const efforts = caps?.reasoningEffort;
        return (
          <SelectItem key={m} value={m}>
            <span className="flex items-center gap-1">
              {m}
              {m === defaultModel ? " (default)" : ""}
              {efforts && efforts.map((e) => (
                <Badge key={e} variant="secondary" className="text-xs font-medium">
                  {e}
                </Badge>
              ))}
            </span>
          </SelectItem>
        );
      })}
    </>
  );
}

// --- Component: ReasoningEffortSelect ---

export interface ReasoningEffortSelectProps {
  supportedEfforts: string[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Label for the "no selection" option */
  noSelectionLabel?: string;
  /** Description text shown below the picker */
  description?: string;
  /** Show a warning that the worker doesn't support effort */
  workerEffortWarning?: boolean;
}

/**
 * Reasoning effort picker. Only renders when supportedEfforts has >1 option.
 */
export function ReasoningEffortSelect({
  supportedEfforts,
  value,
  onChange,
  disabled,
  noSelectionLabel = "Default (no override)",
  description,
  workerEffortWarning,
}: ReasoningEffortSelectProps) {
  if (supportedEfforts.length === 0) return null;

  return (
    <div className="space-y-2">
      <Label htmlFor="reasoningEffort">Reasoning Effort</Label>
      <Select
        value={value || "__none__"}
        onValueChange={(v) => onChange(v === "__none__" ? "" : v)}
        disabled={disabled}
      >
        <SelectTrigger id="reasoningEffort">
          <SelectValue placeholder={noSelectionLabel} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">{noSelectionLabel}</SelectItem>
          {supportedEfforts.map((level) => (
            <SelectItem key={level} value={level}>
              {level}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {workerEffortWarning && (
        <p className="text-xs text-amber-600">
          ⚠ The selected worker does not support reasoning effort selection. This setting may be ignored.
        </p>
      )}
      {description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}
    </div>
  );
}
