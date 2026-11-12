// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { Check, Loader2, Pencil, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Longest accepted name; mirrors `TASK_PROMPT_NAME_MAX_LENGTH` in the API schema. */
export const TASK_PROMPT_NAME_MAX_LENGTH = 100;

interface TaskPromptNameEditorProps {
  /** Current name; `undefined` when the prompt has none. */
  name?: string;
  /**
   * Persist a new name, or `null` to clear it. The editor stays open with an
   * error message if the promise rejects.
   */
  onSave: (name: string | null) => Promise<unknown>;
}

/**
 * Inline editor for a task prompt's human-readable name (#176). Shows the
 * name (or a "No name" placeholder) with an edit button; editing swaps in an
 * input with Save / Cancel. Saving an empty value clears the name.
 */
export function TaskPromptNameEditor({ name, onSave }: TaskPromptNameEditorProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startEditing = () => {
    setDraft(name ?? "");
    setError(null);
    setEditing(true);
  };

  const cancel = () => {
    setEditing(false);
    setError(null);
  };

  // Empty input clears the name; unchanged input just closes the editor.
  const save = async () => {
    const trimmed = draft.trim();
    const next = trimmed === "" ? null : trimmed;
    if (next === (name ?? null)) {
      setEditing(false);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSave(next);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save name");
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <div className="flex items-center gap-2">
        {name ? (
          <span className="text-sm font-medium">{name}</span>
        ) : (
          <span className="text-sm italic text-muted-foreground">No name</span>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={startEditing}
          aria-label={name ? "Edit name" : "Add name"}
          title={name ? "Edit name" : "Add name"}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Input
          autoFocus
          aria-label="Task prompt name"
          placeholder="e.g. ecommerce-order-api"
          value={draft}
          maxLength={TASK_PROMPT_NAME_MAX_LENGTH}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") cancel();
          }}
          className="h-8 max-w-sm"
        />
        <Button type="submit" size="icon" className="h-8 w-8" disabled={saving} aria-label="Save name">
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
        </Button>
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={cancel} disabled={saving} aria-label="Cancel">
          <X className="h-3.5 w-3.5" />
        </Button>
      </form>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <p className="text-xs text-muted-foreground">A label only: leave empty to remove it. The prompt text and ID never change.</p>
    </div>
  );
}
