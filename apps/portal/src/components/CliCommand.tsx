// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { Terminal, Copy, Check, Info, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { CliCommand as CliCommandValue } from "@/lib/cli/buildCommand";

export interface CliCommandProps {
  /** The command to display. Recompute in the parent so it tracks live state. */
  command: CliCommandValue;
  /** Optional label shown next to the terminal glyph (e.g. "CLI"). */
  label?: string;
  /** Modal heading. */
  title?: string;
  /** Tooltip on the trigger. */
  tooltip?: string;
  className?: string;
  /**
   * When true, the trigger is disabled and the modal cannot be opened. Use this
   * when the equivalent action (e.g. the Submit form) is not yet valid.
   */
  disabled?: boolean;
  /**
   * Kept for backwards compatibility with the previous popover API. No longer
   * used now that the affordance is a centered modal.
   */
  align?: "start" | "center" | "end";
}

/** The CLI installer one-liner (see docs/architecture/cli-distribution.md). */
const INSTALL_COMMAND =
  'gh api repos/growth-ecosystems/scope-doc/contents/install-cli.sh -H "Accept: application/vnd.github.raw" | bash';

/** Public documentation home for the Scope CLI. */
const DOCS_URL = "https://aka.ms/projectscope/doc";

/**
 * The API base URL to suggest for `SCOPE_API_URL`.
 *
 * Every supported deployment fronts the API on the same origin as the Portal:
 * nginx proxies `/api/*` in production, and the Vite dev server proxies `/api`
 * in local dev (`src/lib/api.ts` calls it via the relative `/api/v1` base).
 * Because the CLI requests `${SCOPE_API_URL}/api/v1/...`, the current browser
 * origin is the correct, environment-specific value in every case — no
 * hardcoding or per-environment branching needed.
 */
function apiUrl(): string {
  if (typeof window === "undefined" || !window.location?.origin) {
    return "http://localhost:5106";
  }
  return window.location.origin;
}

/** A single copyable command block with its own copy button (GitHub-style). */
function CommandBlock({
  copyValue,
  display,
  toastLabel,
}: {
  /** Exact string written to the clipboard (single line). */
  copyValue: string;
  /** Optional multi-line rendition for display; defaults to copyValue. */
  display?: string;
  toastLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(copyValue);
      setCopied(true);
      toast.success(toastLabel);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy to clipboard");
    }
  };
  return (
    <div className="flex items-start gap-2">
      <pre className="min-w-0 flex-1 overflow-x-auto rounded-md border bg-muted/50 px-3 py-2.5 text-xs leading-relaxed">
        <code className="font-mono text-foreground">{display ?? copyValue}</code>
      </pre>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="shrink-0"
        aria-label="Copy command"
        onClick={copy}
      >
        {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
      </Button>
    </div>
  );
}

/** A numbered step: bold "Step N" lead-in + description, then its content. */
function Step({ n, label, children }: { n: number; label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-foreground">
        <span className="font-semibold">Step {n}</span> {label}
      </p>
      {children}
    </div>
  );
}

/**
 * "Copy as CLI" affordance: a terminal-glyph button that opens a GitHub-style
 * modal with step-by-step instructions to reproduce the user's current Portal
 * state from the `scope` CLI. See lib/cli/buildCommand.ts for the builders.
 */
export function CliCommand({
  command,
  label,
  title = "Run this from the CLI",
  tooltip = "Show CLI equivalent",
  className,
  disabled = false,
}: CliCommandProps) {
  const trigger = label ? (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn("gap-1.5", className)}
      aria-label={tooltip}
      disabled={disabled}
    >
      <Terminal className="h-4 w-4" />
      {label}
    </Button>
  ) : (
    <Button
      variant="ghost"
      size="icon"
      className={cn("h-8 w-8 text-muted-foreground", className)}
      aria-label={tooltip}
      disabled={disabled}
    >
      <Terminal className="h-4 w-4" />
    </Button>
  );

  return (
    <Dialog>
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>{trigger}</DialogTrigger>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Reproduce your current selection from the terminal or wire it into CI. Everything below maps to the state
            you have configured in the Portal.
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-5 py-1">
          <Step n={1} label="Install the Scope CLI (one-time).">
            <CommandBlock copyValue={INSTALL_COMMAND} toastLabel="Install command copied" />
            <p className="text-xs text-muted-foreground">
              Requires Node.js 20+ and an authenticated <code className="font-mono">gh</code> CLI.
            </p>
          </Step>

          <Step n={2} label="Point the CLI at this API.">
            <CommandBlock copyValue={`export SCOPE_API_URL=${apiUrl()}`} toastLabel="Environment variable copied" />
          </Step>

          <Step n={3} label="Run the command.">
            <CommandBlock copyValue={command.command} display={command.display} toastLabel="CLI command copied" />
            {command.notes.length > 0 && (
              <ul className="space-y-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
                {command.notes.map((note, i) => (
                  <li key={i} className="flex gap-2 text-xs leading-snug text-muted-foreground">
                    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                    <span>{note}</span>
                  </li>
                ))}
              </ul>
            )}
          </Step>

          <div className="border-t pt-3">
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Read the CLI documentation
            </a>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
