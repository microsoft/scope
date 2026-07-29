// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  Send, Loader2, Server, Info, BookOpen, Sparkles, Puzzle, SlidersHorizontal,
  X, Save, Plus, ChevronDown, FilePlus2, History, ArrowLeft, Check,
} from "lucide-react";
import {
  WORKER_TYPES, type CodingAgent, type McpServerDocument,
  type ProfileWithVersion, type ProfileVersionDocument, type Run,
} from "@/types";
import { Checkbox } from "@/components/ui/checkbox";
import { CriteriaPicker } from "@/components/CriteriaPicker";
import { CreateCriterionDialog } from "@/components/CreateCriterionDialog";
import { SkillPicker } from "@/components/SkillPicker";
import { ExtensionPicker } from "@/components/ExtensionPicker";
import { ProfileCreateForm } from "@/components/ProfileCreateForm";
import { ProfilePicker } from "@/components/ProfilePicker";
import {
  ModelSelectItems,
  ReasoningEffortSelect,
  useModelCapabilities,
  useReasoningEffort,
} from "@/components/ReasoningEffortSelect";
import { TaskPromptPicker } from "@/components/TaskPromptPicker";
import { useCommandEnter } from "@/hooks/useCommandEnter";
import { KbdBadge } from "@/components/KbdBadge";
import { CliCommand } from "@/components/CliCommand";
import { buildRunSubmit } from "@/lib/cli/buildCommand";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function truncate(text: string, n: number) {
  return text.length > n ? text.slice(0, n - 1).trimEnd() + "…" : text;
}

type VariationDraft = {
  profileId: string;
  profileVersion?: number;
  color?: string;
};

type GraphSelection = { kind: "base" } | { kind: "variation"; index: number };

const VARIATION_COLORS = [
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#06b6d4",
  "#84cc16",
  "#f97316",
];

function randomVariationColor(): string {
  return VARIATION_COLORS[Math.floor(Math.random() * VARIATION_COLORS.length)];
}

interface GalleryCardProps {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  onClick: () => void;
}

function GalleryCard({ icon: Icon, title, description, onClick }: GalleryCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col items-start gap-2 rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon className="h-5 w-5 text-muted-foreground transition-colors group-hover:text-primary" />
      <div className="min-w-0 w-full">
        <p className="truncate text-sm font-medium">{title}</p>
        {description && (
          <p className="truncate text-xs text-muted-foreground">{description}</p>
        )}
      </div>
    </button>
  );
}

interface CollapsibleCardProps {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  summary: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
  children: React.ReactNode;
}

function CollapsibleCard({ icon: Icon, title, summary, open, onOpenChange, disabled, children }: CollapsibleCardProps) {
  return (
    <Card>
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        className="flex w-full items-center justify-between gap-3 p-6 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
      >
        <div className="flex items-center gap-3 min-w-0">
          <Icon className="h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="text-base font-semibold">
              {title}{" "}
              <span className="text-xs font-normal text-muted-foreground">(optional)</span>
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {summary}
              {disabled && " — locked by profile"}
            </p>
          </div>
        </div>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <CardContent className="pt-0">
          {children}
        </CardContent>
      )}
    </Card>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// SubmitRun
// ────────────────────────────────────────────────────────────────────────────

export function SubmitRun() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Form state
  const [task, setTask] = useState("");
  const [pickedCriteria, setPickedCriteria] = useState<string[]>([]);
  const [worker, setWorker] = useState<string>("coder-acp-copilot");
  const [model, setModel] = useState<string>("");
  const [reasoningEffort, setReasoningEffort] = useState<string>("");
  const [maxIterations, setMaxIterations] = useState<number>(10);
  const [occurrences, setOccurrences] = useState<number>(5);
  const [priority, setPriority] = useState<number>(0);

  // Optional add-ons
  const [selectedMcpServers, setSelectedMcpServers] = useState<string[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [selectedExtensions, setSelectedExtensions] = useState<string[]>([]);

  // Profile
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [selectedProfileVersion, setSelectedProfileVersion] = useState<number | null>(null);
  const [variationDrafts, setVariationDrafts] = useState<VariationDraft[]>([]);
  const [variationProfileVersions, setVariationProfileVersions] = useState<Record<string, ProfileVersionDocument[]>>({});
  const profileLocked = !!selectedProfileId;

  // Agent version
  const [selectedAgentVersion, setSelectedAgentVersion] = useState<string>("");

  // Inline criteria creation dialog
  const [createCriterionOpen, setCreateCriterionOpen] = useState(false);
  const [createProfileOpen, setCreateProfileOpen] = useState(false);

  // Save as Profile
  const [saveProfileName, setSaveProfileName] = useState("");
  const [saveProfileOpen, setSaveProfileOpen] = useState(false);

  // UI state
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [extensionsOpen, setExtensionsOpen] = useState(false);
  const [graphSelection, setGraphSelection] = useState<GraphSelection>({ kind: "base" });

  // AI generation
  const [showGenerate, setShowGenerate] = useState(false);
  const [generateDescription, setGenerateDescription] = useState("");

  // ─── Queries ────────────────────────────────────────────────────────────
  const { data: agents = [] } = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.listAgents(),
  });

  const { data: mcpServers = [] } = useQuery({
    queryKey: ["mcp-servers"],
    queryFn: () => api.listMcpServers(),
  });

  const { data: profiles = [] } = useQuery({
    queryKey: ["profiles"],
    queryFn: () => api.listProfiles(),
  });

  const { data: profileVersions = [] } = useQuery({
    queryKey: ["profile-versions", selectedProfileId],
    queryFn: () => api.listProfileVersions(selectedProfileId!),
    enabled: !!selectedProfileId,
  });

  const { data: recentRunsResp } = useQuery({
    queryKey: ["recent-runs", "submit-gallery"],
    queryFn: () => api.listRuns({ limit: 3 }),
  });
  const recentRuns: Run[] = recentRunsResp?.data ?? [];

  // ─── Derived ────────────────────────────────────────────────────────────
  const activeMcpServers = mcpServers.filter((s: McpServerDocument) => !s.deletedAt);
  const activeAgents = agents.filter((a: CodingAgent) => !a.deletedAt);
  const availableAgents = activeAgents.filter((a: CodingAgent) => a.available !== false);
  const selectedAgent = activeAgents.find((a: CodingAgent) => a._id === worker);
  const isVscodeWorker = worker.includes("vscode");
  const profileList = profiles as ProfileWithVersion[];
  const selectedBaseProfile = profileList.find((profile) => profile._id === selectedProfileId);
  const topProfiles = profileList.slice(0, 3);

  // ─── Effects ────────────────────────────────────────────────────────────
  // When agent changes, reset model + clear extensions for non-vscode workers
  useEffect(() => {
    if (selectedProfileId) return;
    if (selectedAgent) {
      setModel(selectedAgent.defaultModel ?? "");
    } else {
      setModel("");
    }
    if (!worker.includes("vscode")) {
      setSelectedExtensions([]);
    }
  }, [worker, selectedAgent?.defaultModel]);

  // Auto-open Extensions section when switching to a VS Code worker that has selected extensions
  useEffect(() => {
    if (isVscodeWorker && selectedExtensions.length > 0) {
      setExtensionsOpen(true);
    }
  }, [isVscodeWorker, selectedExtensions.length]);

  // Fetch active versions for selected agent
  const { data: agentVersions = [] } = useQuery({
    queryKey: ["agent-versions", worker],
    queryFn: () => api.listAgentVersions(worker, "active"),
    enabled: !!worker,
  });

  const sortedVersions = [...agentVersions].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  // Model capabilities and reasoning-effort management
  const { capabilitiesMap: modelCapabilitiesMap } = useModelCapabilities(worker || undefined);
  const onEffortChange = useCallback((v: string) => setReasoningEffort(v), []);
  const { supportedEfforts, workerEffortWarning } = useReasoningEffort({
    model,
    capabilitiesMap: modelCapabilitiesMap,
    value: reasoningEffort,
    onChange: onEffortChange,
    agentSupportsEffort: selectedAgent?.capabilities?.supportsReasoningEffort,
  });

  useEffect(() => {
    if (selectedProfileId) return;
    if (sortedVersions.length > 0) {
      setSelectedAgentVersion(sortedVersions[0].agentVersion);
    } else {
      setSelectedAgentVersion("");
    }
  }, [worker, agentVersions.length]);

  // ─── Handlers ───────────────────────────────────────────────────────────
  const applyVersionConfig = (v: ProfileVersionDocument) => {
    setWorker(v.workerType);
    setModel(v.model);
    setReasoningEffort(v.reasoningEffort ?? "");
    setSelectedAgentVersion(v.agentVersion ?? "");
    setSelectedMcpServers(v.mcpServers ?? []);
    setSelectedSkills(v.skillRevisions ?? []);
    setSelectedExtensions(v.extensions ?? []);
    if ((v.mcpServers ?? []).length > 0) setMcpOpen(true);
    if ((v.skillRevisions ?? []).length > 0) setSkillsOpen(true);
    if ((v.extensions ?? []).length > 0) setExtensionsOpen(true);
  };

  const applyProfile = (profileId: string | null) => {
    setSelectedProfileId(profileId);
    setVariationDrafts((prev) => prev.filter((v) => v.profileId !== profileId));
    setGalleryOpen(false);
    if (!profileId) return;
    const p = profileList.find((p) => p._id === profileId);
    if (!p?.version) return;
    setSelectedProfileVersion(p.version.version);
    applyVersionConfig(p.version);
  };

  const changeProfileVersion = (version: number) => {
    setSelectedProfileVersion(version);
    const v = profileVersions.find((pv: ProfileVersionDocument) => pv.version === version);
    if (v) applyVersionConfig(v);
  };

  const clearProfile = () => {
    setSelectedProfileId(null);
    setSelectedProfileVersion(null);
    setVariationDrafts([]);
  };

  const handleProfileCreated = (profile: ProfileWithVersion) => {
    queryClient.setQueryData<ProfileWithVersion[]>(["profiles"], (previous) => {
      const existing = previous ?? [];
      if (existing.some((item) => item._id === profile._id)) {
        return existing.map((item) => (item._id === profile._id ? profile : item));
      }
      return [profile, ...existing];
    });
    setCreateProfileOpen(false);
    setSelectedProfileId(profile._id);
    setSelectedProfileVersion(profile.version.version);
    setVariationDrafts((prev) => prev.filter((variation) => variation.profileId !== profile._id));
    setGalleryOpen(false);
    applyVersionConfig(profile.version);
  };

  const addVariationDraft = () => {
    setVariationDrafts((prev) => {
      const used = new Set(prev.map((v) => v.profileId).filter(Boolean));
      const nextProfile = profileList.find((p) => p._id !== selectedProfileId && !used.has(p._id));
      if (!nextProfile) {
        toast.info("All available profiles are already used in variations.");
        return prev;
      }
      return [...prev, {
        profileId: nextProfile._id,
        profileVersion: nextProfile.latestVersion,
        color: randomVariationColor(),
      }];
    });
  };

  const updateVariationDraft = (index: number, patch: Partial<VariationDraft>) => {
    setVariationDrafts((prev) => prev.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)));
  };

  const removeVariationDraft = (index: number) => {
    setVariationDrafts((prev) => prev.filter((_, i) => i !== index));
  };

  const getUsedVariationProfileIds = (excludeIndex?: number): Set<string> => {
    const used = new Set<string>();
    variationDrafts.forEach((draft, idx) => {
      if (excludeIndex !== undefined && idx === excludeIndex) return;
      if (draft.profileId.trim()) used.add(draft.profileId);
    });
    return used;
  };

  const getAvailableVariationProfiles = (excludeIndex?: number) => {
    const used = getUsedVariationProfileIds(excludeIndex);
    return profileList.filter((p) => p._id !== selectedProfileId && !used.has(p._id));
  };

  useEffect(() => {
    const profileIds = Array.from(new Set(variationDrafts.map((v) => v.profileId).filter(Boolean)));
    profileIds.forEach((profileId) => {
      if (variationProfileVersions[profileId] !== undefined) return;
      api.listProfileVersions(profileId)
        .then((versions) => {
          setVariationProfileVersions((prev) => ({
            ...prev,
            [profileId]: versions,
          }));
        })
        .catch(() => {
          setVariationProfileVersions((prev) => ({
            ...prev,
            [profileId]: [],
          }));
        });
    });
  }, [variationDrafts, variationProfileVersions]);

  const applyRecentRun = (run: Run) => {
    if (run.scenario?.task) setTask(run.scenario.task);
    if (run.scenario?.criteria) setPickedCriteria(run.scenario.criteria);
    setWorker(run.workerType);
    if (run.model) setModel(run.model);
    if (run.agentVersion) setSelectedAgentVersion(run.agentVersion);
    if (run.maxIterations) setMaxIterations(run.maxIterations);
    if (run.mcpServers && run.mcpServers.length > 0) {
      setSelectedMcpServers(run.mcpServers);
      setMcpOpen(true);
    }
    const skills = run.skillRevisions ?? run.skills ?? [];
    if (skills.length > 0) {
      setSelectedSkills(skills);
      setSkillsOpen(true);
    }
    if (run.extensions && run.extensions.length > 0) {
      setSelectedExtensions(run.extensions);
      setExtensionsOpen(true);
    }
    setGalleryOpen(false);
    toast.success(`Loaded settings from run ${run._id.slice(-6)}`);
  };

  const saveProfileMutation = useMutation({
    mutationFn: () =>
      api.createProfile({
        name: saveProfileName.trim(),
        workerType: worker,
        model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(selectedAgentVersion ? { agentVersion: selectedAgentVersion } : {}),
        ...(selectedMcpServers.length > 0 ? { mcpServers: selectedMcpServers } : {}),
        ...(selectedSkills.length > 0 ? { skillRevisions: selectedSkills } : {}),
        ...(selectedExtensions.length > 0 ? { extensions: selectedExtensions } : {}),
      }),
    onSuccess: (data) => {
      toast.success(`Profile "${saveProfileName}" saved`);
      setSaveProfileOpen(false);
      setSaveProfileName("");
      setSelectedProfileId(data._id);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to save profile");
    },
  });

  const generateMutation = useMutation({
    mutationFn: (opts: { description?: string; existingPrompt?: string }) =>
      api.generateTaskPrompt(opts),
    onSuccess: (data) => {
      setTask(data.taskPrompt);
      setShowGenerate(false);
      setGenerateDescription("");
    },
  });

  const handleGenerate = () => {
    if (task.trim()) {
      generateMutation.mutate({
        existingPrompt: task.trim(),
        ...(generateDescription.trim() && { description: generateDescription.trim() }),
      });
    } else {
      generateMutation.mutate({
        ...(generateDescription.trim() && { description: generateDescription.trim() }),
      });
    }
  };

  const submitMutation = useMutation({
    mutationFn: api.submitRun,
    onSuccess: (data) => {
      if ("ids" in data && data.ids.length > 1) {
        navigate("/runs");
      } else if ("id" in data) {
        navigate(`/runs/${data.id}`);
      } else {
        navigate("/runs");
      }
    },
  });

  const doSubmit = () => {
    if (!task.trim()) return;
    const normalizedVariationDrafts = variationDrafts.filter((v) => v.profileId.trim().length > 0);
    const profileVariations: string[] = normalizedVariationDrafts.map((v) =>
      v.profileVersion ? `${v.profileId}@${v.profileVersion}` : v.profileId
    );
    const inVariationMode = Boolean(selectedProfileId && profileVariations.length > 0);
    const baseProfileSpec = selectedProfileId
      ? (selectedProfileVersion ? `${selectedProfileId}@${selectedProfileVersion}` : selectedProfileId)
      : null;

    submitMutation.mutate({
      scenario: { task: task.trim(), criteria: pickedCriteria },
      ...(inVariationMode ? {} : { ...(worker ? { worker } : {}) }),
      ...(inVariationMode ? {} : { ...(model ? { model } : {}) }),
      ...(inVariationMode ? {} : { ...(reasoningEffort ? { reasoningEffort } : {}) }),
      maxIterations,
      ...(priority !== 0 ? { priority } : {}),
      ...(occurrences > 1 ? { count: occurrences } : {}),
      ...(inVariationMode ? {} : { ...(selectedMcpServers.length > 0 ? { mcpServers: selectedMcpServers } : {}) }),
      ...(inVariationMode ? {} : { ...(selectedSkills.length > 0 ? { skills: selectedSkills } : {}) }),
      ...(inVariationMode ? {} : { ...(selectedExtensions.length > 0 ? { extensions: selectedExtensions } : {}) }),
      ...(inVariationMode ? {} : { ...(selectedAgentVersion ? { agentVersion: selectedAgentVersion } : {}) }),
      ...(inVariationMode
        ? {
            ...(baseProfileSpec ? { profileId: baseProfileSpec } : {}),
            profileVariations,
          }
        : {
            ...(baseProfileSpec ? { profileId: baseProfileSpec } : {}),
          }),
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    doSubmit();
  };

  const canSubmit =
    !!task.trim() &&
    !submitMutation.isPending &&
    !(selectedAgent && selectedAgent.supportedModels.length > 0 && !model) &&
    !(maxIterations !== 1 && pickedCriteria.length === 0);

  const selectedVariationCount = variationDrafts.filter((v) => v.profileId.trim().length > 0).length;
  const compositionProfileCount = selectedProfileId ? 1 + selectedVariationCount : 0;
  const expandedRunCount = compositionProfileCount > 0 ? compositionProfileCount * occurrences : occurrences;
  const submitRunCount = expandedRunCount;
  const lastVariationDraft = variationDrafts.length > 0 ? variationDrafts[variationDrafts.length - 1] : null;

  // Equivalent `scope run submit` command for the "Copy as CLI" affordance.
  const submitCli = useMemo(() => {
    const inVariationMode = !!selectedProfileId && selectedVariationCount > 0;
    const baseProfileSpec = selectedProfileId
      ? selectedProfileVersion
        ? `${selectedProfileId}@${selectedProfileVersion}`
        : selectedProfileId
      : null;
    return buildRunSubmit({
      task,
      criteria: pickedCriteria,
      worker,
      model,
      reasoningEffort,
      maxIterations,
      mcpServers: selectedMcpServers,
      skills: selectedSkills,
      extensions: selectedExtensions,
      agentVersion: selectedAgentVersion || undefined,
      baseProfileId: baseProfileSpec,
      occurrences,
      priority,
      variationMode: inVariationMode,
    });
  }, [
    task, pickedCriteria, worker, model, reasoningEffort, maxIterations,
    selectedMcpServers, selectedSkills, selectedExtensions, selectedAgentVersion,
    selectedProfileId, selectedProfileVersion, occurrences, priority, selectedVariationCount,
  ]);
  const lastVariationName = lastVariationDraft
    ? profileList.find((p) => p._id === lastVariationDraft.profileId)?.name
    : null;

  useEffect(() => {
    setGraphSelection({ kind: "base" });
  }, [selectedProfileId]);

  useEffect(() => {
    setGraphSelection((previous) => {
      if (previous.kind === "variation" && previous.index >= variationDrafts.length) {
        return { kind: "base" };
      }
      return previous;
    });
  }, [variationDrafts.length]);

  const selectedGraphPreview = (() => {
    if (!selectedProfileId) return null;

    if (graphSelection.kind === "base") {
      const versionDocument =
        profileVersions.find((version) => version.version === selectedProfileVersion) ??
        selectedBaseProfile?.version ??
        null;
      return {
        title: "Base Profile",
        name: selectedBaseProfile?.name ?? selectedProfileId,
        version: selectedProfileVersion ?? selectedBaseProfile?.latestVersion ?? null,
        color: "hsl(var(--primary))",
        versionDocument,
      };
    }

    const draft = variationDrafts[graphSelection.index];
    if (!draft) return null;
    const profile = profileList.find((item) => item._id === draft.profileId);
    const versionDocument =
      (variationProfileVersions[draft.profileId] ?? []).find((version) => version.version === draft.profileVersion) ??
      profile?.version ??
      null;

    return {
      title: `Variation #${graphSelection.index + 1}`,
      name: profile?.name ?? draft.profileId,
      version: draft.profileVersion ?? profile?.latestVersion ?? null,
      color: draft.color ?? VARIATION_COLORS[graphSelection.index % VARIATION_COLORS.length],
      versionDocument,
    };
  })();

  useCommandEnter(doSubmit, canSubmit);

  // ─── Render helpers ─────────────────────────────────────────────────────
  const summaryChips: string[] = [
    `${maxIterations} iteration${maxIterations === 1 ? "" : "s"}`,
    `${pickedCriteria.length} criteri${pickedCriteria.length === 1 ? "on" : "a"}`,
    occurrences > 1 ? `×${occurrences} runs` : "",
    worker,
    model || "",
    selectedAgentVersion ? `v${selectedAgentVersion}` : "",
    selectedMcpServers.length > 0 ? `${selectedMcpServers.length} MCP` : "",
    selectedSkills.length > 0 ? `${selectedSkills.length} skill${selectedSkills.length === 1 ? "" : "s"}` : "",
    selectedExtensions.length > 0 ? `${selectedExtensions.length} ext` : "",
  ].filter(Boolean);

  return (
    <form onSubmit={handleSubmit} className="space-y-6 pb-28">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => navigate("/runs")}
          aria-label="Back to runs"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">New Run</h1>
          <p className="text-muted-foreground">Submit a benchmark run to a coding agent worker</p>
        </div>
      </div>

      {/* Quick Start gallery (collapsible, default closed) */}
      {(topProfiles.length > 0 || recentRuns.length > 0) && (
        <CollapsibleCard
          icon={Sparkles}
          title="Quick start"
          summary="Start from a profile or re-run a recent submission"
          open={galleryOpen}
          onOpenChange={setGalleryOpen}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            <GalleryCard
              icon={FilePlus2}
              title="Blank run"
              description="Configure from scratch"
              onClick={() => setGalleryOpen(false)}
            />
            {topProfiles.map((p) => (
              <GalleryCard
                key={p._id}
                icon={SlidersHorizontal}
                title={p.name}
                description={`Profile · v${p.latestVersion} · ${p.version?.workerType ?? "—"}`}
                onClick={() => applyProfile(p._id)}
              />
            ))}
            {recentRuns.map((r) => (
              <GalleryCard
                key={r._id}
                icon={History}
                title={truncate(r.scenario?.task ?? "Untitled run", 60)}
                description={`Recent · ${r.workerType}${r.model ? ` · ${r.model}` : ""}`}
                onClick={() => applyRecentRun(r)}
              />
            ))}
          </div>
          {profileList.length > 3 && (
            <p className="mt-3 text-xs text-muted-foreground">
              {profileList.length - 3} more profile{profileList.length - 3 === 1 ? "" : "s"} available — use the Profile field below.
            </p>
          )}
        </CollapsibleCard>
      )}

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
      <div className="space-y-6">

      {/* ─── Scenario ──────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Scenario</CardTitle>
          <CardDescription>Define the task and evaluation criteria</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="task">Task *</Label>
            <TaskPromptPicker onSelect={(text) => setTask(text)} />
            <Textarea
              id="task"
              placeholder="e.g., Create a Hello World Express API"
              value={task}
              onChange={(e) => setTask(e.target.value)}
              rows={3}
              required
            />
            <div className="flex items-center justify-between">
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Info className="h-3.5 w-3.5 shrink-0" />
                New task prompts are automatically added to the task prompt library.
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="gap-1.5 text-xs"
                onClick={() => setShowGenerate(!showGenerate)}
              >
                <Sparkles className="h-3.5 w-3.5" />
                Suggest Task Prompt
              </Button>
            </div>

            {showGenerate && (
              <div className="rounded-md border bg-muted/30 p-3 space-y-2">
                <Label className="text-xs">
                  {task.trim()
                    ? "How should the variation differ? (optional)"
                    : "Describe what you want, or leave empty for a surprise (optional)"}
                </Label>
                <div className="flex gap-2">
                  <Input
                    placeholder={task.trim()
                      ? "e.g., use Python instead, add database support…"
                      : "e.g., A REST API with database and tests"}
                    value={generateDescription}
                    onChange={(e) => setGenerateDescription(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleGenerate();
                      }
                    }}
                    disabled={generateMutation.isPending}
                  />
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleGenerate}
                    disabled={generateMutation.isPending}
                  >
                    {generateMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Sparkles className="h-4 w-4" />
                    )}
                  </Button>
                </div>
                {generateMutation.isError && (
                  <p className="text-xs text-destructive">
                    {generateMutation.error instanceof Error
                      ? generateMutation.error.message
                      : "Generation failed"}
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="criteria">
              Criteria {maxIterations !== 1 && "* "}
              <span className="text-muted-foreground font-normal">(select from registry)</span>
            </Label>
            <CriteriaPicker
              selected={pickedCriteria}
              onChange={setPickedCriteria}
              inputId="criteria"
              trailingAction={(
                <Button
                  type="button"
                  variant="outline"
                  className="h-9 gap-1.5 px-3"
                  onClick={() => setCreateCriterionOpen(true)}
                >
                  <Plus className="h-3.5 w-3.5" />
                  New…
                </Button>
              )}
            />
            <CreateCriterionDialog
              open={createCriterionOpen}
              onOpenChange={setCreateCriterionOpen}
              onCreated={(id) => setPickedCriteria((prev) => [...prev, id])}
            />
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Info className="h-3.5 w-3.5 shrink-0" />
              Required when max iterations &gt; 1. Optional for single-iteration runs (no judge evaluation).
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="maxIterations">Max iterations</Label>
              <Input
                id="maxIterations"
                type="number"
                min={1}
                max={50}
                value={maxIterations}
                onChange={(e) => setMaxIterations(Math.max(1, Math.min(50, parseInt(e.target.value) || 1)))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="priority">Priority</Label>
              <Input
                id="priority"
                type="number"
                min={-100}
                max={100}
                value={priority}
                onChange={(e) => setPriority(Math.max(-100, Math.min(100, parseInt(e.target.value) || 0)))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="occurrences">Occurrences</Label>
              <Input
                id="occurrences"
                type="number"
                min={1}
                max={10}
                value={occurrences}
                onChange={(e) => setOccurrences(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ─── Agent ─────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Agent</CardTitle>
          <CardDescription>Coding agent, model and version</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="worker">Worker *</Label>
              <Select value={worker} onValueChange={setWorker} disabled={profileLocked}>
                <SelectTrigger id="worker">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {availableAgents.length > 0
                    ? availableAgents.map((a: CodingAgent) => (
                        <SelectItem key={a._id} value={a._id}>
                          {a.name}
                        </SelectItem>
                      ))
                    : WORKER_TYPES.map((w) => (
                        <SelectItem key={w} value={w}>
                          {w}
                        </SelectItem>
                      ))}
                </SelectContent>
              </Select>
            </div>
            {selectedAgent && selectedAgent.supportedModels.length > 0 && (
              <div className="space-y-2">
                <Label htmlFor="model">Model *</Label>
                <Select value={model} onValueChange={setModel} disabled={profileLocked}>
                  <SelectTrigger id="model">
                    <SelectValue placeholder="Select model" />
                  </SelectTrigger>
                  <SelectContent>
                    <ModelSelectItems
                      models={selectedAgent.supportedModels}
                      capabilitiesMap={modelCapabilitiesMap}
                      defaultModel={selectedAgent.defaultModel}
                    />
                  </SelectContent>
                </Select>
              </div>
            )}
            {supportedEfforts.length > 0 && (
              <div className="space-y-2">
                <ReasoningEffortSelect
                  supportedEfforts={supportedEfforts}
                  value={reasoningEffort}
                  onChange={onEffortChange}
                  disabled={profileLocked}
                  noSelectionLabel="Any (no preference)"
                  workerEffortWarning={workerEffortWarning}
                />
              </div>
            )}
            {sortedVersions.length > 0 && (
              <div className="space-y-2">
                <Label htmlFor="agentVersion">Agent version *</Label>
                <Select value={selectedAgentVersion} onValueChange={setSelectedAgentVersion} disabled={profileLocked}>
                  <SelectTrigger id="agentVersion">
                    <SelectValue placeholder="Select version" />
                  </SelectTrigger>
                  <SelectContent>
                    {sortedVersions.map((v, i) => (
                      <SelectItem key={v.agentVersion} value={v.agentVersion}>
                        {v.agentVersion}{i === 0 ? " (latest)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ─── MCP Servers (collapsible) ─────────────────────────────────── */}
      {activeMcpServers.length > 0 && (
        <CollapsibleCard
          icon={Server}
          title="MCP Servers"
          summary={
            selectedMcpServers.length === 0
              ? "None selected"
              : `${selectedMcpServers.length} server${selectedMcpServers.length === 1 ? "" : "s"} selected`
          }
          open={mcpOpen}
          onOpenChange={setMcpOpen}
          disabled={profileLocked}
        >
          <div className="space-y-2">
            {activeMcpServers.map((s: McpServerDocument) => (
              <label
                key={s._id}
                className={`flex items-center gap-3 rounded-md border p-3 transition-colors ${profileLocked ? "opacity-60" : "cursor-pointer hover:bg-accent/50"}`}
              >
                <Checkbox
                  checked={selectedMcpServers.includes(s._id)}
                  disabled={profileLocked}
                  onCheckedChange={(checked) => {
                    setSelectedMcpServers((prev) =>
                      checked ? [...prev, s._id] : prev.filter((id) => id !== s._id)
                    );
                  }}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm">{s._id}</span>
                    <Badge variant="outline" className="text-xs uppercase">{s.type}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground truncate">
                    {s.name}{s.description ? ` — ${s.description}` : ""}
                  </p>
                </div>
              </label>
            ))}
          </div>
        </CollapsibleCard>
      )}

      {/* ─── Skills (collapsible) ──────────────────────────────────────── */}
      <CollapsibleCard
        icon={BookOpen}
        title="Skills"
        summary={
          selectedSkills.length === 0
            ? "None selected"
            : `${selectedSkills.length} skill${selectedSkills.length === 1 ? "" : "s"} selected`
        }
        open={skillsOpen}
        onOpenChange={setSkillsOpen}
        disabled={profileLocked}
      >
        <SkillPicker selected={selectedSkills} onChange={setSelectedSkills} disabled={profileLocked} />
      </CollapsibleCard>

      {/* ─── Extensions (collapsible, VS Code only) ────────────────────── */}
      {isVscodeWorker && (
        <CollapsibleCard
          icon={Puzzle}
          title="Extensions"
          summary={
            selectedExtensions.length === 0
              ? "None selected"
              : `${selectedExtensions.length} extension${selectedExtensions.length === 1 ? "" : "s"} selected`
          }
          open={extensionsOpen}
          onOpenChange={setExtensionsOpen}
          disabled={profileLocked}
        >
          <ExtensionPicker selected={selectedExtensions} onChange={setSelectedExtensions} disabled={profileLocked} />
        </CollapsibleCard>
      )}
      </div>

      <Card className="xl:sticky xl:top-6">
        <CardHeader>
          <CardTitle>Profile Variations</CardTitle>
          <CardDescription>
            Choose a base profile and compose profile variations for comparative runs.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {profileList.length === 0 ? (
            <div className="space-y-3 rounded-md border border-dashed p-3 text-xs text-muted-foreground">
              <p>Create a profile to enable profile-based configuration and profile variations.</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => setCreateProfileOpen(true)}
              >
                <Plus className="h-3.5 w-3.5" />
                New…
              </Button>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label className="text-sm">Base Profile</Label>
                <div className="flex items-center gap-2">
                  <ProfilePicker
                    profiles={profileList}
                    selectedProfileId={selectedProfileId}
                    onSelect={applyProfile}
                    placeholder="Search existing profiles…"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="h-9 gap-1.5 px-3"
                    onClick={() => setCreateProfileOpen(true)}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    New…
                  </Button>
                  {selectedProfileId && (
                    <Button type="button" variant="ghost" size="icon" className="h-9 w-9" onClick={clearProfile} aria-label="Clear profile">
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
                {selectedProfileId && (
                  <div className="rounded-md border border-primary/40 bg-primary/5 px-2.5 py-1.5 text-xs">
                    <p className="flex items-center gap-1.5 font-medium text-primary">
                      <Check className="h-3.5 w-3.5" />
                      Base profile selected
                    </p>
                    <p className="mt-0.5 text-foreground">
                      {selectedBaseProfile?.name ?? selectedProfileId} v{selectedBaseProfile?.latestVersion ?? selectedProfileVersion ?? "?"}
                    </p>
                  </div>
                )}
              </div>

              {selectedProfileId && profileVersions.length > 1 && selectedProfileVersion && (
                <div className="space-y-1">
                  <Label className="text-xs">Base profile version</Label>
                  <Select
                    value={String(selectedProfileVersion)}
                    onValueChange={(v) => changeProfileVersion(Number(v))}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {profileVersions
                        .slice()
                        .sort((a: ProfileVersionDocument, b: ProfileVersionDocument) => b.version - a.version)
                        .map((v: ProfileVersionDocument) => (
                          <SelectItem key={v.version} value={String(v.version)}>
                            v{v.version}
                            {v.version === profileList.find((p) => p._id === selectedProfileId)?.latestVersion
                              ? " (latest)"
                              : ""}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </>
          )}

          {selectedProfileId && (
            <div className="space-y-3 rounded-md border p-3">
              <div className="rounded-md border bg-muted/30 p-3">
                <svg
                  className="h-auto w-full"
                  viewBox={`0 0 320 ${Math.max(70, 50 + variationDrafts.length * 34)}`}
                  preserveAspectRatio="none"
                  aria-label="Profile composition graph"
                >
                  {(() => {
                    const baseName = selectedBaseProfile?.name ?? selectedProfileId ?? "Base profile";
                    return (
                      <g
                        onClick={() => setGraphSelection({ kind: "base" })}
                        style={{ cursor: "pointer" }}
                      >
                        <text
                          x="34"
                          y="22"
                          fontSize="10"
                          fill="currentColor"
                          className="text-foreground"
                        >
                          {truncate(baseName, 28)}
                        </text>
                      </g>
                    );
                  })()}
                  <circle
                    cx="20"
                    cy="18"
                    r={graphSelection.kind === "base" ? 7 : 6}
                    fill="hsl(var(--primary))"
                    style={{ cursor: "pointer" }}
                    onClick={() => setGraphSelection({ kind: "base" })}
                  />
                  {variationDrafts.map((draft, index) => {
                    const y = 48 + index * 34;
                    const color = draft.color ?? VARIATION_COLORS[index % VARIATION_COLORS.length];
                    const variationName = profileList.find((p) => p._id === draft.profileId)?.name ?? "Variation";
                    return (
                      <g
                        key={`variation-link-${index}`}
                        onClick={() => setGraphSelection({ kind: "variation", index })}
                        style={{ cursor: "pointer" }}
                      >
                        <path
                          d={`M20 24 V${y} H68`}
                          stroke={color}
                          strokeWidth="1.75"
                          strokeDasharray="4 4"
                          fill="none"
                        >
                          <animate attributeName="stroke-dashoffset" from="8" to="0" dur="0.9s" repeatCount="indefinite" />
                        </path>
                        <circle cx="68" cy={y} r={graphSelection.kind === "variation" && graphSelection.index === index ? 6 : 5} fill={color} />
                        <text x="80" y={y + 4} fontSize="9" fill="currentColor" className="text-foreground">
                          {truncate(variationName, 28)}
                        </text>
                      </g>
                    );
                  })}
                </svg>
              </div>

              {selectedGraphPreview && (
                <div className="rounded-md border bg-background p-2.5 text-xs">
                  <p className="font-medium text-foreground">{selectedGraphPreview.title}</p>
                  <p className="mt-1 truncate" style={{ color: selectedGraphPreview.color }}>
                    {selectedGraphPreview.name} {selectedGraphPreview.version ? `v${selectedGraphPreview.version}` : ""}
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    {selectedGraphPreview.versionDocument?.workerType ?? "worker: n/a"} · {selectedGraphPreview.versionDocument?.model ?? "model: n/a"}
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    {(selectedGraphPreview.versionDocument?.mcpServers?.length ?? 0)} MCP · {(selectedGraphPreview.versionDocument?.skillRevisions?.length ?? 0)} skills · {(selectedGraphPreview.versionDocument?.extensions?.length ?? 0)} extensions
                  </p>
                </div>
              )}

              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-sm">Variations</Label>
                  <p className="text-xs text-muted-foreground">
                    Add additional profiles under the selected base profile.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addVariationDraft}
                  disabled={getAvailableVariationProfiles().length === 0}
                  className="gap-1.5"
                >
                  <Plus className="h-4 w-4" />{" "}
                  {lastVariationName ? `Add after ${truncate(lastVariationName, 24)}` : "Add"}
                </Button>
              </div>

              {variationDrafts.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No variations yet. This will submit only the base profile.
                </p>
              )}

              {variationDrafts.map((draft, index) => {
                const selectedVariationProfile = profileList.find((p) => p._id === draft.profileId);
                const availableProfiles = getAvailableVariationProfiles(index);
                const hasAvailableProfiles = availableProfiles.length > 0;
                const variationVersionOptions = (() => {
                  if (!draft.profileId) return [] as number[];
                  const fetched = variationProfileVersions[draft.profileId] ?? [];
                  if (fetched.length > 0) {
                    return fetched.map((v) => v.version).sort((a, b) => b - a);
                  }
                  return selectedVariationProfile?.latestVersion ? [selectedVariationProfile.latestVersion] : [];
                })();

                return (
                  <div
                    key={`${draft.profileId}-${index}`}
                    className="rounded-md border p-3"
                    style={{
                      borderLeftWidth: 4,
                      borderLeftColor: draft.color ?? VARIATION_COLORS[index % VARIATION_COLORS.length],
                    }}
                  >
                    <div className="flex items-end gap-2">
                      <div className="flex-1 space-y-1">
                        <Label className="text-xs">Variation #{index + 1}</Label>
                        <Select
                          value={draft.profileId || undefined}
                          onValueChange={(value) => {
                            const selectedProfile = profileList.find((p) => p._id === value);
                            updateVariationDraft(index, {
                              profileId: value,
                              profileVersion: selectedProfile?.latestVersion,
                            });
                          }}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select profile" />
                          </SelectTrigger>
                          <SelectContent>
                            {availableProfiles.map((p) => (
                              <SelectItem key={p._id} value={p._id}>
                                {p.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {!draft.profileId && hasAvailableProfiles && (
                          <p className="text-xs text-muted-foreground">Select a profile for this variation.</p>
                        )}
                        {!hasAvailableProfiles && !draft.profileId && (
                          <p className="text-xs text-muted-foreground">No profile available for this variation.</p>
                        )}
                      </div>
                      <div className="w-36 space-y-1">
                        <Label className="text-xs">Version</Label>
                        <Select
                          value={String(draft.profileVersion ?? variationVersionOptions[0] ?? "")}
                          onValueChange={(value) => updateVariationDraft(index, { profileVersion: Number(value) })}
                          disabled={!draft.profileId}
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue placeholder={draft.profileId ? "Select version" : "Select profile first"} />
                          </SelectTrigger>
                          <SelectContent>
                            {variationVersionOptions.map((version) => (
                              <SelectItem key={version} value={String(version)}>
                                v{version}
                                {version === selectedVariationProfile?.latestVersion ? " (latest)" : ""}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9"
                        onClick={() => removeVariationDraft(index)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Variations:</span>{" "}
            {compositionProfileCount > 0 ? `${compositionProfileCount} profiles` : "manual mode"} ·{" "}
            {selectedVariationCount} variations · {expandedRunCount} expanded runs
          </div>
        </CardContent>
      </Card>
      </div>

      <Dialog open={createProfileOpen} onOpenChange={setCreateProfileOpen}>
        <DialogContent className="max-h-[90vh] max-w-3xl grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
          <DialogHeader>
            <DialogTitle>New Profile</DialogTitle>
            <DialogDescription>
              Create a profile without leaving this run configuration.
            </DialogDescription>
          </DialogHeader>
          <div className="-mx-6 min-h-0 overflow-y-auto px-6">
            <ProfileCreateForm
              className="pb-1"
              onCreated={handleProfileCreated}
              stickyFooter
              showCancel={false}
            />
          </div>
        </DialogContent>
      </Dialog>

      {/* ─── Sticky action bar ─────────────────────────────────────────── */}
      <div className="sticky bottom-0 -mx-6 lg:-mx-8 -mb-6 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 px-6 lg:px-8 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {summaryChips.map((chip, i) => (
              <span key={i} className="flex items-center gap-2">
                {i > 0 && <span className="text-muted-foreground/40">·</span>}
                <span>{chip}</span>
              </span>
            ))}
          </div>
          <div className="flex items-center gap-2">
            {submitMutation.isError && (
              <p className="text-xs text-destructive">
                {submitMutation.error instanceof Error ? submitMutation.error.message : "Submission failed"}
              </p>
            )}
            {!profileLocked && worker && model && (
              <Dialog open={saveProfileOpen} onOpenChange={setSaveProfileOpen}>
                <DialogTrigger asChild>
                  <Button type="button" variant="outline" size="sm" className="gap-1.5">
                    <Save className="h-4 w-4" /> Save as Profile
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Save as Profile</DialogTitle>
                    <DialogDescription>
                      Save the current agent configuration as a reusable profile.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-2 py-2">
                    <Label htmlFor="profileName">Profile Name *</Label>
                    <Input
                      id="profileName"
                      value={saveProfileName}
                      onChange={(e) => setSaveProfileName(e.target.value)}
                      placeholder="e.g. My Benchmark Profile"
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && saveProfileName.trim()) {
                          e.preventDefault();
                          saveProfileMutation.mutate();
                        }
                      }}
                    />
                  </div>
                  <DialogFooter>
                    <Button
                      onClick={() => saveProfileMutation.mutate()}
                      disabled={!saveProfileName.trim() || saveProfileMutation.isPending}
                    >
                      {saveProfileMutation.isPending ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Save className="mr-2 h-4 w-4" />
                      )}
                      Save
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            )}
            <CliCommand command={submitCli} label="CLI" title="Submit from the CLI" align="end" disabled={!canSubmit} />
            <Button type="submit" disabled={!canSubmit} className="gap-1.5">
              {submitMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              Submit {submitRunCount > 1 ? `${submitRunCount} Runs` : "Run"}
              <KbdBadge />
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
}
