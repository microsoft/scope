// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * SkillImportWizard — two-step wizard for importing one or many skills
 * from a single GitHub repository.
 *
 * Step 1: User enters a `owner/repo` slug. We call `GET /api/v1/skills/discover`
 *         to list every skill found in well-known directories.
 * Step 2: User checks one or more skills. Clicking "Import" fires N parallel
 *         POST /api/v1/skills requests (each one auto-resolves on the server).
 *         Per-skill progress (queued → importing → done/failed) is shown.
 */

import { useState, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { SkillDiscoveryResult } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Download,
  Loader2,
  RefreshCw,
  Search,
  X,
} from "lucide-react";

type ImportStatus = "queued" | "importing" | "done" | "failed";

interface ImportProgress {
  skillName: string;
  status: ImportStatus;
  error?: string;
}

interface SkillImportWizardProps {
  /** Called when the user closes the wizard (e.g. after a successful import) */
  onClose?: () => void;
}

export function SkillImportWizard({ onClose }: SkillImportWizardProps) {
  const queryClient = useQueryClient();

  const [step, setStep] = useState<1 | 2>(1);
  const [source, setSource] = useState("");
  const [discovered, setDiscovered] = useState<SkillDiscoveryResult[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<Map<string, ImportProgress>>(new Map());

  // ─── Step 1: Discover skills in repo ──────────────────────────────
  const discoverMutation = useMutation({
    mutationFn: (repoSource: string) => api.discoverSkills(repoSource),
    onSuccess: (results) => {
      setDiscovered(results);
      // Default-select skills that are new OR have an update available.
      // Up-to-date skills start unchecked so the user doesn't accidentally
      // re-import everything on every visit.
      setSelected(
        new Set(
          results
            .filter((r) => !r.existsInLibrary || r.updateAvailable)
            .map((r) => r.skillName)
        )
      );
      setProgress(new Map());
      setStep(2);
    },
  });

  const sourceValid = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.trim());

  const handleDiscover = useCallback(() => {
    if (!sourceValid) return;
    discoverMutation.mutate(source.trim());
  }, [source, sourceValid, discoverMutation]);

  // ─── Step 2: Selection helpers ────────────────────────────────────
  const toggleSelected = (skillName: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(skillName)) next.delete(skillName);
      else next.add(skillName);
      return next;
    });
  };

  const selectAll = () =>
    setSelected(
      new Set(
        discovered
          .filter((r) => !r.existsInLibrary || r.updateAvailable)
          .map((r) => r.skillName)
      )
    );
  const selectNone = () => setSelected(new Set());

  // ─── Step 2: Import the selected skills in parallel ───────────────
  const importMutation = useMutation({
    mutationFn: async (toImport: SkillDiscoveryResult[]) => {
      // Initialize all rows as queued
      const initial = new Map<string, ImportProgress>();
      for (const s of toImport) initial.set(s.skillName, { skillName: s.skillName, status: "queued" });
      setProgress(initial);

      // Run in parallel; track each independently so failures don't abort siblings.
      await Promise.all(
        toImport.map(async (skill) => {
          setProgress((prev) => {
            const next = new Map(prev);
            next.set(skill.skillName, { skillName: skill.skillName, status: "importing" });
            return next;
          });
          try {
            await api.createSkill({
              source: source.trim(),
              skillName: skill.skillName,
              name: skill.name ?? skill.skillName,
              origin: "manual",
              ...(skill.description ? { description: skill.description } : {}),
            });
            setProgress((prev) => {
              const next = new Map(prev);
              next.set(skill.skillName, { skillName: skill.skillName, status: "done" });
              return next;
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setProgress((prev) => {
              const next = new Map(prev);
              next.set(skill.skillName, { skillName: skill.skillName, status: "failed", error: message });
              return next;
            });
          }
        })
      );

      queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
  });

  const handleImport = () => {
    const toImport = discovered.filter((d) => selected.has(d.skillName));
    if (toImport.length === 0) return;
    importMutation.mutate(toImport);
  };

  const reset = () => {
    setStep(1);
    setSource("");
    setDiscovered([]);
    setSelected(new Set());
    setProgress(new Map());
    discoverMutation.reset();
    importMutation.reset();
  };

  // ─── Derived state for progress summary ───────────────────────────
  const progressList = Array.from(progress.values());
  const doneCount = progressList.filter((p) => p.status === "done").length;
  const failedCount = progressList.filter((p) => p.status === "failed").length;
  const totalCount = progressList.length;
  const allFinished = totalCount > 0 && progressList.every((p) => p.status === "done" || p.status === "failed");

  // ───────────────────────────────────────────────────────────────────
  return (
    <div className="rounded-md border p-4 space-y-4 bg-muted/30">
      {/* Step indicator */}
      <div className="flex items-center gap-2 text-xs">
        <span className={`flex items-center justify-center h-5 w-5 rounded-full font-medium ${
          step === 1 ? "bg-primary text-primary-foreground" : "bg-primary/20 text-primary"
        }`}>
          {step > 1 ? <Check className="h-3 w-3" /> : "1"}
        </span>
        <span className={step === 1 ? "font-medium" : "text-muted-foreground"}>Repository</span>
        <Separator className="flex-1" />
        <span className={`flex items-center justify-center h-5 w-5 rounded-full font-medium ${
          step === 2 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
        }`}>2</span>
        <span className={step === 2 ? "font-medium" : "text-muted-foreground"}>Select skills</span>
      </div>

      {/* ───────── Step 1: Repository ───────── */}
      {step === 1 && (
        <div className="space-y-3">
          <div className="grid gap-2">
            <Label htmlFor="wizard-source" className="text-xs">GitHub Repository</Label>
            <Input
              id="wizard-source"
              placeholder="e.g. Azure/documentdb-agent-kit"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && sourceValid && !discoverMutation.isPending) {
                  e.preventDefault();
                  handleDiscover();
                }
              }}
              className="h-9 text-sm font-mono"
              autoFocus
            />
            <p className="text-[11px] text-muted-foreground">
              The wizard scans well-known directories (<code>skills/</code>, <code>.agents/skills/</code>, …) for skills.
            </p>
          </div>

          {discoverMutation.isError && (
            <p className="text-xs text-destructive">
              {discoverMutation.error instanceof Error ? discoverMutation.error.message : "Failed to discover skills"}
            </p>
          )}

          <div className="flex justify-end gap-2">
            {onClose && (
              <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            )}
            <Button
              size="sm"
              className="gap-1.5"
              disabled={!sourceValid || discoverMutation.isPending}
              onClick={handleDiscover}
            >
              {discoverMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Search className="h-3.5 w-3.5" />
              )}
              Discover
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      {/* ───────── Step 2: Select & import ───────── */}
      {step === 2 && (
        <div className="space-y-3">
          {/* Wraps on narrow widths so a long repository never pushes the
              selection controls out of view. */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0 text-xs text-muted-foreground break-words">
              <span className="font-mono break-all">{source.trim()}</span> · {discovered.length} skill{discovered.length === 1 ? "" : "s"} found
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                disabled={importMutation.isPending}
                onClick={selectAll}
              >Select all</Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                disabled={importMutation.isPending}
                onClick={selectNone}
              >Select none</Button>
            </div>
          </div>

          {discovered.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-6">
              No skills found in this repository.
            </div>
          ) : (
            <ScrollArea className="h-64 rounded border bg-background">
              <ul className="divide-y">
                {discovered.map((skill) => {
                  const prog = progress.get(skill.skillName);
                  const isSelected = selected.has(skill.skillName);
                  const upToDate = skill.existsInLibrary && !skill.updateAvailable;
                  return (
                    <li
                      key={skill.skillPath}
                      className={`flex items-start gap-2 p-2 ${upToDate ? "opacity-60" : ""}`}
                    >
                      <Checkbox
                        id={`wizard-skill-${skill.skillName}`}
                        checked={isSelected}
                        onCheckedChange={() => toggleSelected(skill.skillName)}
                        disabled={importMutation.isPending || prog?.status === "done" || prog?.status === "importing"}
                        className="mt-0.5"
                      />
                      <label
                        htmlFor={`wizard-skill-${skill.skillName}`}
                        className="flex-1 min-w-0 cursor-pointer"
                      >
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-mono text-xs font-medium break-all">{skill.skillName}</span>
                          <span className="text-[10px] text-muted-foreground font-mono break-all">{skill.skillPath}</span>
                          <LibraryStatusBadge skill={skill} />
                        </div>
                        {(skill.name || skill.description) && (
                          <p className="text-xs text-muted-foreground break-words">
                            {skill.name}{skill.description ? ` — ${skill.description}` : ""}
                          </p>
                        )}
                        {prog?.status === "failed" && prog.error && (
                          <p className="text-[11px] text-destructive mt-0.5 break-words">{prog.error}</p>
                        )}
                      </label>
                      <ImportStatusBadge status={prog?.status} />
                    </li>
                  );
                })}
              </ul>
            </ScrollArea>
          )}

          {/* Progress summary */}
          {totalCount > 0 && (
            <div className="text-xs text-muted-foreground">
              {allFinished ? (
                <>
                  Imported {doneCount}/{totalCount}
                  {failedCount > 0 ? ` · ${failedCount} failed` : ""}
                </>
              ) : (
                <>Importing {doneCount}/{totalCount}…</>
              )}
            </div>
          )}

          <div className="flex flex-wrap justify-between gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5"
              disabled={importMutation.isPending}
              onClick={reset}
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back
            </Button>
            <div className="ml-auto flex flex-wrap justify-end gap-2">
              {allFinished && failedCount > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => {
                    // Retry only the failed ones
                    const failedSkillNames = new Set(progressList.filter((p) => p.status === "failed").map((p) => p.skillName));
                    setSelected(failedSkillNames);
                    const toRetry = discovered.filter((d) => failedSkillNames.has(d.skillName));
                    importMutation.mutate(toRetry);
                  }}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Retry failed
                </Button>
              )}
              {allFinished ? (
                <Button size="sm" className="gap-1.5" onClick={() => { reset(); onClose?.(); }}>
                  <Check className="h-3.5 w-3.5" />
                  Done
                </Button>
              ) : (
                <Button
                  size="sm"
                  className="gap-1.5"
                  disabled={selected.size === 0 || importMutation.isPending}
                  onClick={handleImport}
                >
                  {importMutation.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                  Import {selected.size} skill{selected.size === 1 ? "" : "s"}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ImportStatusBadge({ status }: { status?: ImportStatus }) {
  if (!status) return null;
  if (status === "queued") {
    return <span className="text-[10px] text-muted-foreground shrink-0">queued</span>;
  }
  if (status === "importing") {
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground shrink-0" />;
  }
  if (status === "done") {
    return <Check className="h-3.5 w-3.5 text-green-600 shrink-0" />;
  }
  return <X className="h-3.5 w-3.5 text-destructive shrink-0" />;
}

function LibraryStatusBadge({ skill }: { skill: SkillDiscoveryResult }) {
  if (!skill.existsInLibrary) {
    return (
      <span className="text-[9px] uppercase tracking-wide px-1 py-0.5 rounded bg-blue-500/15 text-blue-700 dark:text-blue-300 font-semibold">
        New
      </span>
    );
  }
  if (skill.updateAvailable) {
    return (
      <span
        className="text-[9px] uppercase tracking-wide px-1 py-0.5 rounded bg-amber-500/20 text-amber-800 dark:text-amber-300 font-semibold"
        title={
          skill.currentRevisionCommitSha && skill.latestUpstreamCommitSha
            ? `Current ${skill.currentRevisionCommitSha.slice(0, 7)} \u2192 ${skill.latestUpstreamCommitSha.slice(0, 7)}`
            : undefined
        }
      >
        Update available
      </span>
    );
  }
  return (
    <span
      className="text-[9px] uppercase tracking-wide px-1 py-0.5 rounded bg-muted text-muted-foreground font-semibold"
      title={skill.lastImportedAt ? `Imported ${new Date(skill.lastImportedAt).toLocaleString()}` : undefined}
    >
      Up to date
    </span>
  );
}
