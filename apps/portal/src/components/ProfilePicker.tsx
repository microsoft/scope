// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Search } from "lucide-react";

import type { ProfileWithVersion } from "@/types";
import { Input } from "@/components/ui/input";
import { truncate } from "@/lib/utils";
import { AgentBadge } from "@/components/AgentBadge";

interface ProfilePickerProps {
  profiles: ProfileWithVersion[];
  selectedProfileId: string | null;
  onSelect: (profileId: string | null) => void;
  placeholder?: string;
  workerNameById?: ReadonlyMap<string, string>;
}

export function ProfilePicker({
  profiles,
  selectedProfileId,
  onSelect,
  placeholder = "Search existing profiles…",
  workerNameById,
}: ProfilePickerProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const filteredProfiles = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return profiles;

    return profiles.filter((profile) => {
      const name = profile.name.toLowerCase();
      const id = profile._id.toLowerCase();
      const worker = profile.version.workerType.toLowerCase();
      const workerName = workerNameById?.get(profile.version.workerType)?.toLowerCase() ?? "";
      const model = profile.version.model.toLowerCase();
      return (
        name.includes(normalized) ||
        id.includes(normalized) ||
        worker.includes(normalized) ||
        workerName.includes(normalized) ||
        model.includes(normalized)
      );
    });
  }, [profiles, query, workerNameById]);

  useEffect(() => {
    setHighlightIdx(0);
  }, [filteredProfiles]);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleSelect = useCallback(
    (profileId: string) => {
      onSelect(profileId);
      setQuery("");
      setOpen(false);
    },
    [onSelect],
  );

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightIdx((idx) => Math.min(idx + 1, filteredProfiles.length - 1));
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightIdx((idx) => Math.max(idx - 1, 0));
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      const item = filteredProfiles[highlightIdx];
      if (item) handleSelect(item._id);
      return;
    }

    if (event.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div ref={containerRef} className="relative min-w-0 flex-1 space-y-1">
      <div className="flex items-center gap-2">
        <Search className="h-4 w-4 text-muted-foreground" />
        <Input
          value={query}
          placeholder={placeholder}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          className="h-9 text-sm"
        />
      </div>

      {open && (
        <div className="absolute z-50 mt-1 max-h-[240px] w-full overflow-y-auto rounded-md border bg-popover shadow-md">
          {filteredProfiles.length === 0 ? (
            <div className="p-3 text-center text-sm text-muted-foreground">
              {query ? "No matching profiles" : "No profiles available"}
            </div>
          ) : (
            <ul className="py-1">
              {filteredProfiles.map((profile, idx) => {
                const isSelected = profile._id === selectedProfileId;
                return (
                <li
                  key={profile._id}
                  className={`cursor-pointer px-3 py-2 text-sm ${
                    idx === highlightIdx
                      ? "bg-accent text-accent-foreground"
                      : isSelected
                        ? "bg-primary/10 text-primary hover:bg-primary/15"
                        : "hover:bg-accent/50"
                  }`}
                  onMouseEnter={() => setHighlightIdx(idx)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => handleSelect(profile._id)}
                >
                  <p className="flex items-center justify-between gap-2 font-medium">
                    {truncate(profile.name, 80)}
                    {isSelected && <Check className="h-4 w-4 shrink-0" />}
                  </p>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <span>v{profile.latestVersion} ·</span>
                    <AgentBadge
                      agentId={profile.version.workerType}
                      triggerLink={false}
                      className="text-xs"
                    />
                    <span>· {profile.version.model}</span>
                  </div>
                </li>
              );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
