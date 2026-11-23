// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  PROJECT_STORAGE_KEY,
  setSelectedProjectIdHolder,
} from "@/lib/project-scope";

/**
 * Selected-project state for the Portal, mirroring {@link ThemeContext}.
 *
 * Holds the id of the active project (**may be unset** — there is no default
 * project). The setter persists to `localStorage` and mirrors the value into the
 * module-level holder in {@link file://../lib/project-scope.ts} so the non-hook
 * API facade can read it when building scoped requests.
 */
interface ProjectContextValue {
  /** Active project id, or `undefined` when none is selected. */
  selectedProjectId: string | undefined;
  /** Whether a project is currently selected. */
  hasProject: boolean;
  /** Select a project (or pass `undefined` to clear the selection). */
  setSelectedProjectId: (id: string | undefined) => void;
}

const ProjectContext = createContext<ProjectContextValue | undefined>(undefined);

function readStored(): string | undefined {
  try {
    const raw = localStorage.getItem(PROJECT_STORAGE_KEY);
    const trimmed = raw?.trim();
    return trimmed ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

export interface ProjectProviderProps {
  children: ReactNode;
}

export function ProjectProvider({ children }: ProjectProviderProps) {
  const [selectedProjectId, setState] = useState<string | undefined>(() => {
    const stored = readStored();
    // Seed the api.ts holder synchronously on first render so a scoped request
    // fired during initial mount already sees the persisted selection.
    setSelectedProjectIdHolder(stored);
    return stored;
  });

  const setSelectedProjectId = useCallback((id: string | undefined) => {
    const next = id?.trim() || undefined;
    setState(next);
    setSelectedProjectIdHolder(next);
    try {
      if (next) localStorage.setItem(PROJECT_STORAGE_KEY, next);
      else localStorage.removeItem(PROJECT_STORAGE_KEY);
    } catch {
      /* ignore unavailable storage */
    }
  }, []);

  const value = useMemo<ProjectContextValue>(
    () => ({
      selectedProjectId,
      hasProject: selectedProjectId !== undefined,
      setSelectedProjectId,
    }),
    [selectedProjectId, setSelectedProjectId],
  );

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProjectContext(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error("useProjectContext must be used within a ProjectProvider");
  return ctx;
}

/** Convenience accessor for just the selected project id. */
export function useSelectedProjectId(): string | undefined {
  return useProjectContext().selectedProjectId;
}

/** Like {@link useSelectedProjectId}, but returns undefined outside a ProjectProvider. */
export function useOptionalSelectedProjectId(): string | undefined {
  return useContext(ProjectContext)?.selectedProjectId;
}
