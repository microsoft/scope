// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useMemo, useState } from "react";
import { ChevronsUpDown, Filter, Search, X } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { CriterionKind } from "@/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";

interface CriteriaFilterBarProps {
  availableCriteria: string[];
  selectedCriteria: string[];
  onToggle: (id: string) => void;
  onClear: () => void;
  /**
   * Optional bulk-select handler. Receives the full desired selection (current
   * selection unioned with the currently-visible options). When provided, the
   * popover shows a "Select all" / "Select N results" action. Looping `onToggle`
   * is unsafe for URL-param-backed state, so callers should set the selection in
   * one shot here.
   */
  onSelectAll?: (ids: string[]) => void;
  /** Override the card title (default: "Success Criteria Filter") */
  title?: string;
  /** Override the description when nothing is selected */
  emptyDescription?: string;
  /** Override the description template when criteria are selected (receives count) */
  selectedDescription?: (count: number) => string;
  /** Optional kind metadata for rendering gate/observation filter chips. */
  criteriaKinds?: Record<string, CriterionKind | undefined>;
  selectedKinds?: CriterionKind[];
  onToggleKind?: (kind: CriterionKind) => void;
  /** Override the noun used in the trigger/search controls (default: "criteria") */
  itemLabel?: string;
  /**
   * Render inline without the surrounding Card, header, or description — just the
   * picker trigger and selected chips. Lets callers compose several filters into
   * a single dense container (e.g. the Statistics "Filters" card).
   */
  compact?: boolean;
}

export function CriteriaFilterBar({
  availableCriteria,
  selectedCriteria,
  onToggle,
  onClear,
  onSelectAll,
  title = "Success Criteria Filter",
  emptyDescription = "Click criteria to filter runs and redefine success. Default: all criteria in each run must pass.",
  selectedDescription = (count: number) =>
    `Success = all ${count} selected criteria pass. Runs without these criteria are excluded.`,
  criteriaKinds,
  selectedKinds = [],
  onToggleKind,
  itemLabel = "criteria",
  compact = false,
}: CriteriaFilterBarProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const selectedSet = useMemo(
    () => new Set(selectedCriteria),
    [selectedCriteria],
  );
  const selectedCount = selectedCriteria.length;

  const query = search.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      query
        ? availableCriteria.filter((c) => c.toLowerCase().includes(query))
        : availableCriteria,
    [availableCriteria, query],
  );

  if (availableCriteria.length === 0) {
    return null;
  }

  const selectedKindSet = new Set(selectedKinds);
  const kindCounts = criteriaKinds
    ? {
        gate: availableCriteria.filter((id) => (criteriaKinds[id] ?? "gate") === "gate").length,
        observation: availableCriteria.filter((id) => criteriaKinds[id] === "observation").length,
      }
    : undefined;

  const handleSelectAll = () => {
    if (!onSelectAll) return;
    onSelectAll(Array.from(new Set([...selectedCriteria, ...filtered])));
  };

  const body = (
    <div className="flex flex-col gap-3">
      {kindCounts && onToggleKind && (
        <div className="flex flex-wrap gap-1.5">
          {(["gate", "observation"] as const).map((kind) => (
            <Badge
              key={kind}
              variant={selectedKindSet.has(kind) ? "default" : "outline"}
              className="cursor-pointer capitalize transition-colors hover:bg-muted"
              onClick={() => onToggleKind(kind)}
            >
              {kind} ({kindCounts[kind]})
            </Badge>
          ))}
        </div>
      )}
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setSearch("");
        }}
      >
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between sm:w-auto sm:min-w-[16rem]"
          >
            <span className="flex items-center gap-2">
              <Filter className="h-3.5 w-3.5" />
              {selectedCount > 0
                ? `Filtering by ${itemLabel}`
                : `Filter ${itemLabel}`}
              {selectedCount > 0 && (
                <Badge variant="secondary" className="ml-1">
                  {selectedCount}
                </Badge>
              )}
            </span>
            <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[22rem] max-w-[90vw] p-0">
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <Input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${itemLabel}…`}
              className="h-8 border-0 bg-transparent px-0 py-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
            />
          </div>

          <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs text-muted-foreground">
            <span>
              {selectedCount} of {availableCriteria.length} selected
            </span>
            <div className="flex items-center gap-3">
              {onSelectAll && filtered.length > 0 && (
                <button
                  type="button"
                  onClick={handleSelectAll}
                  className="hover:text-foreground underline"
                >
                  {query
                    ? `Select ${filtered.length} result${filtered.length === 1 ? "" : "s"}`
                    : "Select all"}
                </button>
              )}
              {selectedCount > 0 && (
                <button
                  type="button"
                  onClick={onClear}
                  className="hover:text-foreground underline"
                >
                  Clear all
                </button>
              )}
            </div>
          </div>

          <ScrollArea className="max-h-72">
            {filtered.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                No {itemLabel} match “{search}”.
              </div>
            ) : (
              <ul className="p-1">
                {filtered.map((id) => {
                  const isSelected = selectedSet.has(id);
                  return (
                    <li key={id}>
                      <button
                        type="button"
                        onClick={() => onToggle(id)}
                        className="flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                      >
                        <Checkbox
                          checked={isSelected}
                          tabIndex={-1}
                          aria-hidden
                          className="pointer-events-none mt-0.5"
                        />
                        <span className="break-all">{id}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </ScrollArea>
        </PopoverContent>
      </Popover>

      {selectedCount > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedCriteria.map((id) => (
            <Badge
              key={id}
              variant="default"
              className="cursor-pointer bg-primary transition-colors hover:bg-primary/80"
              onClick={() => onToggle(id)}
            >
              {id}
              <X className="ml-1 h-3 w-3" />
            </Badge>
          ))}
        </div>
      )}
    </div>
  );

  if (compact) {
    return body;
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">{title}</CardTitle>
          </div>
          {selectedCount > 0 && (
            <button
              onClick={onClear}
              className="text-xs text-muted-foreground hover:text-foreground underline"
            >
              Clear all
            </button>
          )}
        </div>
        <CardDescription>
          {selectedCount === 0
            ? emptyDescription
            : selectedDescription(selectedCount)}
        </CardDescription>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}
