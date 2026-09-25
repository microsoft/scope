// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { X, Search, Download, Loader2, ChevronDown, ChevronUp, Globe, BookOpen } from "lucide-react";
import type { SkillDocument, SkillRevisionDocument, SkillSearchResult } from "@/types";
import { toast } from "sonner";
import { SkillImportWizard } from "@/components/SkillImportWizard";
import { parseSkillSpec, shortCommitHash } from "@/lib/skill-spec";

// ---------------------------------------------------------------------------
// Revision selector for a single selected skill
// ---------------------------------------------------------------------------
function RevisionSelector({ slug, currentCommitHash, onRevisionChange }: {
  slug: string;
  currentCommitHash?: string;
  onRevisionChange: (commitHash?: string) => void;
}) {
  const { data: revisions = [], isLoading } = useQuery({
    queryKey: ["skill-revisions", slug],
    queryFn: () => api.listSkillRevisions(slug),
  });

  return (
    <div className="flex items-center gap-2 pl-6">
      <Select
        value={currentCommitHash ?? "__latest__"}
        onValueChange={(v) => onRevisionChange(v === "__latest__" ? undefined : v)}
      >
        <SelectTrigger className="h-7 w-52 text-xs font-mono">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__latest__">latest</SelectItem>
          {isLoading && <SelectItem value="__loading__" disabled>Loading…</SelectItem>}
          {revisions.map((r: SkillRevisionDocument, idx: number) => (
            <SelectItem key={r.ref} value={r.commitHash}>
              {shortCommitHash(r.commitHash)}{idx === 0 ? " (latest)" : ""} — {new Date(r.resolvedAt).toLocaleDateString()}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hook: debounce a value
// ---------------------------------------------------------------------------
function useDebounce<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
interface SkillPickerProps {
  /** Currently selected skill specs (slug or slug@commitHash) */
  selected: string[];
  /** Called when selection changes */
  onChange: (specs: string[]) => void;
  /** If true, hide the selection badges / multi-select — only show search+import (for SkillList page) */
  importOnly?: boolean;
  /** If true, show selected items as read-only (no remove, no search) */
  disabled?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export function SkillPicker({ selected, onChange, importOnly = false, disabled = false }: SkillPickerProps) {
  const queryClient = useQueryClient();
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [manualOpen, setManualOpen] = useState(false);

  const debouncedQuery = useDebounce(query, 300);

  // ─── Data: prefetch all internal skills ─────────────────────────────
  const { data: internalSkills = [], isLoading: loadingInternal } = useQuery({
    queryKey: ["skills"],
    queryFn: () => api.listSkills(),
  });

  const activeInternal = useMemo(
    () => internalSkills.filter((s: SkillDocument) => !s.deletedAt),
    [internalSkills],
  );

  // ─── Data: external search (on-demand, debounced) ───────────────────
  const { data: externalResults = [], isFetching: fetchingExternal } = useQuery({
    queryKey: ["skills-external", debouncedQuery],
    queryFn: () => api.searchExternalSkills(debouncedQuery, 10),
    enabled: debouncedQuery.length >= 2,
  });

  // ─── Client-side filter internal skills ─────────────────────────────
  const internalMatches = useMemo(() => {
    if (!query.trim()) return importOnly ? [] : activeInternal.slice(0, 8);
    const q = query.toLowerCase();
    return activeInternal.filter(
      (s) =>
        s._id.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q) ||
        (s.description?.toLowerCase().includes(q) ?? false),
    );
  }, [activeInternal, query, importOnly]);

  // ─── Deduplicate external against internal ──────────────────────────
  const internalIds = useMemo(
    () => new Set(activeInternal.map((s) => s._id)),
    [activeInternal],
  );

  const filteredExternal = useMemo(
    () => externalResults.filter((s: SkillSearchResult) => !internalIds.has(s.id)),
    [externalResults, internalIds],
  );

  // ─── Unified list for keyboard navigation ───────────────────────────
  type ListItem =
    | { kind: "internal"; skill: SkillDocument }
    | { kind: "external"; result: SkillSearchResult };

  const items: ListItem[] = useMemo(() => {
    const list: ListItem[] = internalMatches.map((s) => ({
      kind: "internal" as const,
      skill: s,
    }));
    if (debouncedQuery.length >= 2) {
      filteredExternal.forEach((r) =>
        list.push({ kind: "external" as const, result: r }),
      );
    }
    return list;
  }, [internalMatches, filteredExternal, debouncedQuery]);

  // Reset highlight when items change
  useEffect(() => {
    setHighlightIdx(0);
  }, [items.length]);

  // ─── Outside click ──────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // ─── Import mutation (for external skills) ──────────────────────────
  const importMutation = useMutation({
    mutationFn: (result: SkillSearchResult) =>
      api.createSkill({
        source: result.source,
        skillName: result.id.includes("/")
          ? result.id.split("/").slice(2).join("/") || result.id.split("/").pop()!
          : result.id,
        name: result.name,
        origin: "skills-sh",
        ...(result.description ? { description: result.description } : {}),
      }),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      toast.success(`Skill "${created._id}" imported`);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Failed to import skill");
    },
  });

  // ─── Parse selected specs into a map for quick lookup ─────────────
  const selectedMap = useMemo(() => {
    const map = new Map<string, string | undefined>(); // slug → commitHash|undefined
    for (const spec of selected) {
      const { slug, commitHash } = parseSkillSpec(spec);
      map.set(slug, commitHash);
    }
    return map;
  }, [selected]);

  // ─── Selection helpers ──────────────────────────────────────────────
  const toggleItem = useCallback(
    (id: string) => {
      if (importOnly) return;
      if (selectedMap.has(id)) {
        onChange(selected.filter((s) => parseSkillSpec(s).slug !== id));
      } else {
        onChange([...selected, id]); // Add without hash (latest)
      }
      setQuery("");
      inputRef.current?.focus();
    },
    [selected, selectedMap, onChange, importOnly],
  );

  const removeItem = (slug: string) => {
    onChange(selected.filter((s) => parseSkillSpec(s).slug !== slug));
  };

  const updateRevision = useCallback(
    (slug: string, commitHash?: string) => {
      onChange(selected.map((spec) => {
        const parsed = parseSkillSpec(spec);
        if (parsed.slug === slug) return commitHash ? `${slug}@${commitHash}` : slug;
        return spec;
      }));
    },
    [selected, onChange],
  );

  // ─── Keyboard ───────────────────────────────────────────────────────
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIdx((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items[highlightIdx];
      if (item?.kind === "internal") {
        toggleItem(item.skill._id);
      }
      // For external items, Enter does nothing — user must click Import
    } else if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "Backspace" && !query && selected.length > 0 && !importOnly) {
      const lastSpec = selected[selected.length - 1];
      removeItem(parseSkillSpec(lastSpec).slug);
    }
  };

  if (loadingInternal) {
    return <Skeleton className="h-9 w-full" />;
  }

  const showDropdown = open && (items.length > 0 || (query && debouncedQuery.length >= 2 && fetchingExternal));

  return (
    <div ref={containerRef} className="relative space-y-2 min-w-0">
      {/* Selected skills with revision selectors */}
      {!importOnly && selected.length > 0 && (
        <div className="space-y-1.5">
          {selected.map((spec) => {
            const { slug, commitHash } = parseSkillSpec(spec);
            return (
              <div key={slug} className="rounded-md border p-2 space-y-1">
                <div className="flex items-center gap-1.5">
                  <BookOpen className="h-3 w-3 text-muted-foreground" />
                  <span className="font-mono text-xs font-medium flex-1">{slug}</span>
                  {commitHash && (
                    <Badge variant="outline" className="text-[10px] font-mono">{shortCommitHash(commitHash)}</Badge>
                  )}
                  {!commitHash && (
                    <Badge variant="secondary" className="text-[10px]">latest</Badge>
                  )}
                  {!disabled && (
                    <X
                      className="h-3 w-3 cursor-pointer text-muted-foreground hover:text-destructive"
                      onClick={() => removeItem(slug)}
                    />
                  )}
                </div>
                {!disabled && (
                  <RevisionSelector
                    slug={slug}
                    currentCommitHash={commitHash}
                    onRevisionChange={(hash) => updateRevision(slug, hash)}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Search input */}
      {!disabled && (
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder="Search for skills…"
          className="h-9 pl-9 font-mono text-sm"
        />
        {fetchingExternal && debouncedQuery.length >= 2 && (
          <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
        )}
      </div>
      )}

      {/* Dropdown */}
      {showDropdown && (
        <div className="absolute z-50 top-full mt-1 w-full rounded-md border bg-popover shadow-md">
          <div className="max-h-64 overflow-y-auto p-1">
            {/* Internal results */}
            {internalMatches.length > 0 && (
              <>
                {debouncedQuery.length >= 2 && filteredExternal.length > 0 && (
                  <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Imported
                  </div>
                )}
                {internalMatches.map((skill, idx) => {
                  const isSelected = selectedMap.has(skill._id);
                  return (
                    <button
                      key={skill._id}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => toggleItem(skill._id)}
                      onMouseEnter={() => setHighlightIdx(idx)}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-sm text-left text-sm transition-colors ${
                        idx === highlightIdx ? "bg-accent text-accent-foreground" : ""
                      } ${importOnly ? "cursor-default" : "cursor-pointer"}`}
                    >
                      {!importOnly && (
                        <span className={`flex items-center justify-center h-4 w-4 rounded border text-[10px] shrink-0 ${
                          isSelected ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/30"
                        }`}>
                          {isSelected && "✓"}
                        </span>
                      )}
                      <BookOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="font-mono font-medium shrink-0">{skill._id}</span>
                      <span className="text-xs text-muted-foreground truncate">
                        {skill.name}{skill.description ? ` — ${skill.description}` : ""}
                      </span>
                    </button>
                  );
                })}
              </>
            )}

            {/* External results */}
            {debouncedQuery.length >= 2 && filteredExternal.length > 0 && (
              <>
                <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground mt-1 border-t pt-2">
                  <Globe className="inline h-3 w-3 mr-1" />
                  External Registry
                </div>
                {filteredExternal.map((result, i) => {
                  const globalIdx = internalMatches.length + i;
                  return (
                    <div
                      key={result.id}
                      onMouseEnter={() => setHighlightIdx(globalIdx)}
                      className={`flex items-center gap-2 px-2 py-1.5 rounded-sm text-sm transition-colors ${
                        globalIdx === highlightIdx ? "bg-accent text-accent-foreground" : ""
                      }`}
                    >
                      <Globe className="h-3.5 w-3.5 shrink-0 text-blue-500" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono font-medium text-xs">{result.id}</span>
                          {result.installs != null && (
                            <span className="text-[10px] text-muted-foreground">
                              {result.installs.toLocaleString()} installs
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground truncate">
                          {result.name}{result.description ? ` — ${result.description}` : ""}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-xs gap-1 shrink-0"
                        disabled={importMutation.isPending}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={(e) => {
                          e.stopPropagation();
                          importMutation.mutate(result);
                        }}
                      >
                        {importMutation.isPending ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Download className="h-3 w-3" />
                        )}
                        Import
                      </Button>
                    </div>
                  );
                })}
              </>
            )}

            {/* Loading indicator for external */}
            {debouncedQuery.length >= 2 && fetchingExternal && filteredExternal.length === 0 && (
              <div className="px-2 py-2 text-xs text-muted-foreground flex items-center gap-2">
                <Loader2 className="h-3 w-3 animate-spin" />
                Searching external registry…
              </div>
            )}

            {/* Empty state */}
            {items.length === 0 && !fetchingExternal && query.trim() && (
              <div className="p-3 text-sm text-muted-foreground text-center">
                No matching skills found
              </div>
            )}
          </div>
        </div>
      )}

      {/* Manual add section */}
      {!disabled && (
      <div className="mt-1.5">
        <button
          type="button"
          onClick={() => setManualOpen(!manualOpen)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {manualOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          Import from repository
        </button>

        {manualOpen && (
          <div className="mt-2">
            <SkillImportWizard onClose={() => setManualOpen(false)} />
          </div>
        )}
      </div>
      )}
    </div>
  );
}
