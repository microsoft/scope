// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Apple, AppWindow } from "lucide-react";
import { FaLinux } from "react-icons/fa";
import { AgentBadge } from "@/components/AgentBadge";
import { ShortId } from "@/components/ShortId";
import { StatusBadge, OutcomeBadge, type StatusBadgeStatus } from "@/components/StatusBadge";
import { TaskPromptBadge } from "@/components/TaskPromptBadge";
import { TaxonomyStatus } from "@/components/TaxonomyStatus";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatId, truncate } from "@/lib/utils";
import type {
  OsInfo,
  Run,
  RunOutcome,
  RunState,
  TaxonomyHandlerSummary,
} from "@/types";

export interface RunTableItem {
  requestId: string;
  runId: string;
  task?: string;
  criteria?: string[];
  taskPromptId?: string;
  experimentId?: string;
  workerType?: string;
  model?: string;
  reasoningEffort?: string;
  agentVersion?: string;
  os?: OsInfo;
  mcpServers?: string[];
  skillRevisions?: string[];
  extensions?: string[];
  profileId?: string;
  priority?: number;
  status?: StatusBadgeStatus;
  outcome?: RunOutcome;
  attemptNumber?: number;
  worker?: RunState["worker"];
  lastHeartbeatAt?: RunState["lastHeartbeatAt"];
  startedAt?: RunState["startedAt"];
  taxonomyHandler?: TaxonomyHandlerSummary;
}

export function runTableItemFromRun(run: Run): RunTableItem {
  return {
    requestId: run._id,
    runId: run.run?._id ?? run._id,
    task: run.scenario?.task,
    criteria: run.scenario?.criteria,
    taskPromptId: run.taskPromptId,
    experimentId: run.experimentId,
    workerType: run.workerType,
    model: run.model,
    reasoningEffort: run.reasoningEffort,
    agentVersion: run.agentVersion,
    os: run.run?.os,
    mcpServers: run.mcpServers,
    skillRevisions: run.skillRevisions ?? run.skills,
    extensions: run.extensions,
    profileId: run.profileId,
    priority: run.priority,
    status: run.run?.status,
    outcome: run.run?.outcome,
    attemptNumber: run.run?.attemptNumber,
    worker: run.run?.worker,
    lastHeartbeatAt: run.run?.lastHeartbeatAt,
    startedAt: run.run?.startedAt,
    taxonomyHandler: run.taxonomyHandler,
  };
}

export function EmptyRunCell() {
  return <span className="text-xs text-muted-foreground">—</span>;
}

export function RunIdCell({ item }: { item: RunTableItem }) {
  return <ShortId id={item.requestId} label="run ID" />;
}

export function RunTaskCell({ item }: { item: RunTableItem }) {
  if (!item.task) return <EmptyRunCell />;
  if (!item.taskPromptId) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="block max-w-[360px] cursor-default truncate text-sm">
            {truncate(item.task, 60)}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm text-xs">{item.task}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <TaskPromptBadge taskPromptId={item.taskPromptId} className="block truncate">
      <span className="cursor-pointer text-sm hover:underline">
        {truncate(item.task, 60)}
      </span>
    </TaskPromptBadge>
  );
}

/** Compact inline badges with overflow for dense table cells. */
export function OverflowBadges({
  items,
  max = 1,
  renderItem,
  renderMenuItem,
}: {
  items: string[];
  max?: number;
  renderItem: (item: string) => ReactNode;
  renderMenuItem: (item: string) => ReactNode;
}) {
  const visible = items.slice(0, max);
  const hidden = items.slice(max);
  return (
    <div className="flex min-w-0 items-center gap-1">
      {visible.map((item) => renderItem(item))}
      {hidden.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex shrink-0 items-center rounded-md border bg-muted px-2 py-0.5 font-mono text-xs transition-colors hover:bg-accent"
              onClick={(event) => event.stopPropagation()}
            >
              +{hidden.length}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-64 overflow-y-auto">
            {hidden.map((item) => renderMenuItem(item))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

export function RunCriteriaCell({ item }: { item: RunTableItem }) {
  const criteria = item.criteria ?? [];
  if (criteria.length === 0) return <EmptyRunCell />;
  return (
    <OverflowBadges
      items={criteria}
      renderItem={(criterionId) => (
        <Tooltip key={criterionId}>
          <TooltipTrigger asChild>
            <Link
              to={`/criteria/${criterionId}`}
              className="inline-flex items-center rounded-md border px-2 py-0.5 font-mono text-xs transition-colors hover:bg-accent"
              onClick={(event) => event.stopPropagation()}
            >
              {criterionId}
            </Link>
          </TooltipTrigger>
          <TooltipContent className="text-xs">{criterionId}</TooltipContent>
        </Tooltip>
      )}
      renderMenuItem={(criterionId) => (
        <DropdownMenuItem key={criterionId} asChild>
          <Link
            to={`/criteria/${criterionId}`}
            className="font-mono text-xs"
            onClick={(event) => event.stopPropagation()}
          >
            {criterionId}
          </Link>
        </DropdownMenuItem>
      )}
    />
  );
}

export function RunWorkerCell({ item }: { item: RunTableItem }) {
  if (!item.workerType) return <EmptyRunCell />;
  return (
    <AgentBadge
      agentId={item.workerType}
      version={item.agentVersion}
      variant="badge"
      className="max-w-[160px] min-w-0"
    />
  );
}

export function RunVersionCell({ item }: { item: RunTableItem }) {
  if (!item.agentVersion) return <EmptyRunCell />;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="block cursor-default truncate font-mono text-xs">
          {item.agentVersion}
        </span>
      </TooltipTrigger>
      <TooltipContent className="text-xs">{item.agentVersion}</TooltipContent>
    </Tooltip>
  );
}

export function OsPlatformIcon({ platform }: { platform: string }) {
  const normalized = platform.toLowerCase();
  const Icon =
    normalized === "darwin" || normalized === "macos"
      ? Apple
      : normalized === "win32" || normalized === "windows"
        ? AppWindow
        : normalized === "linux"
          ? FaLinux
          : null;
  const label =
    normalized === "darwin" || normalized === "macos"
      ? "macOS"
      : normalized === "win32" || normalized === "windows"
        ? "Windows"
        : normalized === "linux"
          ? "Linux"
          : platform;
  if (!Icon) {
    return (
      <Badge variant="outline" className="h-5 px-1.5 font-mono text-[10px]">
        {platform}
      </Badge>
    );
  }
  return <Icon className="h-3.5 w-3.5" aria-label={label} />;
}

export function RunOsCell({ item }: { item: RunTableItem }) {
  if (!item.os) return <EmptyRunCell />;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-default items-center">
          <OsPlatformIcon platform={item.os.platform} />
        </span>
      </TooltipTrigger>
      <TooltipContent className="text-xs">
        {item.os.platform} {item.os.release} ({item.os.arch})
      </TooltipContent>
    </Tooltip>
  );
}

function LinkedValuesCell({
  values,
  href,
  label,
}: {
  values: string[];
  href: (value: string) => string;
  label: (value: string) => string;
}) {
  if (values.length === 0) return <EmptyRunCell />;
  return (
    <OverflowBadges
      items={values}
      renderItem={(value) => (
        <Tooltip key={value}>
          <TooltipTrigger asChild>
            <Link
              to={href(value)}
              className="inline-flex items-center rounded-md border px-2 py-0.5 font-mono text-xs transition-colors hover:bg-accent"
              onClick={(event) => event.stopPropagation()}
            >
              {truncate(label(value), 20)}
            </Link>
          </TooltipTrigger>
          <TooltipContent className="text-xs">{value}</TooltipContent>
        </Tooltip>
      )}
      renderMenuItem={(value) => (
        <DropdownMenuItem key={value} asChild>
          <Link
            to={href(value)}
            className="font-mono text-xs"
            onClick={(event) => event.stopPropagation()}
          >
            {label(value)}
          </Link>
        </DropdownMenuItem>
      )}
    />
  );
}

export function RunMcpCell({ item }: { item: RunTableItem }) {
  return (
    <LinkedValuesCell
      values={item.mcpServers ?? []}
      href={(value) => `/mcp-servers/${value}`}
      label={(value) => value}
    />
  );
}

export function RunSkillsCell({ item }: { item: RunTableItem }) {
  return (
    <LinkedValuesCell
      values={item.skillRevisions ?? []}
      href={(value) => `/skills/${value.split("@")[0]}`}
      label={(value) => value.split("@")[0].split("/").pop() ?? value}
    />
  );
}

export function RunExtensionsCell({ item }: { item: RunTableItem }) {
  return (
    <LinkedValuesCell
      values={item.extensions ?? []}
      href={(value) => `/extensions/${value.split("@")[0]}`}
      label={(value) => {
        const [qualifiedName, version] = value.split("@");
        const shortName = qualifiedName.split(".").pop() ?? value;
        return `${shortName}${version ? `@${version}` : ""}`;
      }}
    />
  );
}

export function RunProfileCell({
  item,
  profileNameById,
}: {
  item: RunTableItem;
  profileNameById?: ReadonlyMap<string, string>;
}) {
  if (!item.profileId) return <EmptyRunCell />;
  const label = profileNameById?.get(item.profileId) ?? formatId(item.profileId);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="block min-w-0 cursor-default truncate text-xs font-medium">
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent className="text-xs">{label}</TooltipContent>
    </Tooltip>
  );
}

export function RunPriorityCell({ item }: { item: RunTableItem }) {
  return item.priority == null ? (
    <EmptyRunCell />
  ) : (
    <span className="font-mono text-xs">{item.priority}</span>
  );
}

export function RunModelCell({ item }: { item: RunTableItem }) {
  if (!item.model) return <EmptyRunCell />;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="block max-w-[120px] cursor-default truncate font-mono text-xs">
          {item.model}
        </span>
      </TooltipTrigger>
      <TooltipContent className="text-xs">{item.model}</TooltipContent>
    </Tooltip>
  );
}

export function RunEffortCell({ item }: { item: RunTableItem }) {
  return item.reasoningEffort ? (
    <span className="font-mono text-xs">{item.reasoningEffort}</span>
  ) : (
    <EmptyRunCell />
  );
}

export function RunStatusCell({ item }: { item: RunTableItem }) {
  return item.status ? (
    <StatusBadge
      status={item.status}
      worker={item.worker}
      lastHeartbeatAt={item.lastHeartbeatAt}
      startedAt={item.startedAt}
    />
  ) : (
    <EmptyRunCell />
  );
}

export function RunOutcomeCell({ item }: { item: RunTableItem }) {
  return item.outcome ? <OutcomeBadge outcome={item.outcome} /> : <EmptyRunCell />;
}

export function RunTaxonomyCell({ item }: { item: RunTableItem }) {
  return <TaxonomyStatus summary={item.taxonomyHandler} />;
}

export function RunAttemptCell({ item }: { item: RunTableItem }) {
  return item.attemptNumber == null ? (
    <EmptyRunCell />
  ) : (
    <span className="font-mono text-xs">#{item.attemptNumber}</span>
  );
}
