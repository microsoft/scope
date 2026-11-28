// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { type ReactNode, useState, useEffect, useCallback } from "react";
import { PanelLeft, PanelLeftClose, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import { useIsCompactViewport } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/utils";
import { getListSectionIcon } from "@/components/navigation-icons";

export interface ListLayoutProps {
  /** Page title (rendered above the table). */
  title: ReactNode;
  /** Page description (rendered under the title). */
  description?: ReactNode;
  /** Optional header action slot (e.g. "New" button). */
  actions?: ReactNode;
  /** Left filter rail content. Pass `null` to hide the rail entirely. */
  filterRail: ReactNode | null;
  /** Main listing content (table, pagination, etc). */
  children: ReactNode;
  /**
   * Right detail panel content. When `null` or `undefined` the panel is hidden
   * and the main area expands to fill the remaining width.
   */
  detail?: ReactNode;
  /**
   * Optional secondary panel slotted between the filter rail and the main
   * area (e.g. <CustomizeColumnsPanel>). Hidden when null/undefined.
   */
  secondaryPanel?: ReactNode;
  /**
   * Called when the user closes the detail panel on compact viewports
   * (`< lg`), where the panel is rendered as a right Sheet. Typically a
   * navigation back to the list route. If omitted, the close button is
   * still shown but only closes the sheet visually.
   */
  onDetailClose?: () => void;
  /**
   * Called when the user dismisses the secondary panel on compact viewports.
   */
  onSecondaryClose?: () => void;
  /** Persisted localStorage key for the rail collapsed state. */
  railStorageKey?: string;
  /** Width of the filter rail when expanded. */
  railWidth?: string;
  /** Width of the detail panel. */
  detailWidth?: string;
  className?: string;
}

const DEFAULT_RAIL_WIDTH = "clamp(220px, 22vw, 280px)";
const DEFAULT_DETAIL_WIDTH = "clamp(360px, 30vw, 440px)";

export function ListLayout({
  title,
  description,
  actions,
  filterRail,
  children,
  detail,
  secondaryPanel,
  onDetailClose,
  onSecondaryClose,
  railStorageKey,
  railWidth = DEFAULT_RAIL_WIDTH,
  detailWidth = DEFAULT_DETAIL_WIDTH,
  className,
}: ListLayoutProps) {
  const fullKey = railStorageKey ? `scope:list-layout:${railStorageKey}:rail-collapsed` : null;
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => {
    if (!fullKey) return false;
    try {
      return localStorage.getItem(fullKey) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (!fullKey) return;
    try {
      localStorage.setItem(fullKey, railCollapsed ? "1" : "0");
    } catch { /* ignore */ }
  }, [fullKey, railCollapsed]);

  const toggleRail = useCallback(() => setRailCollapsed((v) => !v), []);

  // Compact (mobile/tablet) state — sheets only mount when the viewport is < lg.
  const isCompact = useIsCompactViewport();
  const [mobileRailOpen, setMobileRailOpen] = useState(false);

  const detailVisible = detail !== null && detail !== undefined && detail !== false;
  const secondaryVisible = secondaryPanel !== null && secondaryPanel !== undefined && secondaryPanel !== false;
  const hasRail = filterRail !== null;
  const SectionIcon = getListSectionIcon(railStorageKey) ?? SlidersHorizontal;

  return (
    <div className={cn("flex h-full min-h-0 w-full overflow-hidden", className)}>
      {/* Left filter rail — inline on lg+ only */}
      {hasRail && (
        <aside
          className={cn(
            "hidden shrink-0 overflow-hidden transition-[width] duration-200 ease-out lg:block",
            railCollapsed ? "w-0 border-r-0" : "border-r border-border/60",
          )}
          style={{ width: railCollapsed ? 0 : railWidth }}
          aria-hidden={railCollapsed}
        >
          <div
            className="h-full min-w-0 overflow-hidden"
            style={{ width: railWidth }}
          >
            {filterRail}
          </div>
        </aside>
      )}

      {/* Secondary panel (e.g. customize columns) — inline on lg+ only */}
      {secondaryVisible && <div className="hidden lg:contents">{secondaryPanel}</div>}

      {/* Main column: header + content */}
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border/60 px-4 py-3">
          <div className="flex min-w-0 items-start gap-2">
            {hasRail && (
              <>
                {/* Inline rail toggle (lg+) */}
                <Button
                  variant="ghost"
                  size="icon"
                  className="hidden h-8 w-8 shrink-0 lg:inline-flex"
                  onClick={toggleRail}
                  aria-label={railCollapsed ? "Show filters" : "Hide filters"}
                  title={railCollapsed ? "Show filters" : "Hide filters"}
                >
                  {railCollapsed ? (
                    <PanelLeft className="h-4 w-4" />
                  ) : (
                    <PanelLeftClose className="h-4 w-4" />
                  )}
                </Button>
                {/* Compact rail trigger (< lg) */}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 lg:hidden"
                  onClick={() => setMobileRailOpen(true)}
                  aria-label="Open filters"
                  title="Open filters"
                >
                  <SectionIcon className="h-4 w-4" />
                </Button>
              </>
            )}
            <div className="min-w-0">
              <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
              {description && (
                <p className="mt-0.5 truncate text-sm text-muted-foreground">{description}</p>
              )}
            </div>
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-4">{children}</div>
      </section>

      {/* Right detail panel — inline on lg+ */}
      {detailVisible && (
        <aside
          className="hidden shrink-0 border-l border-border/60 lg:block"
          style={{ width: detailWidth }}
        >
          {detail}
        </aside>
      )}

      {/* Compact filter rail sheet (< lg) */}
      {hasRail && isCompact && (
        <Sheet open={mobileRailOpen} onOpenChange={setMobileRailOpen}>
          <SheetContent
            side="left"
            className="w-[85vw] max-w-sm overflow-y-auto p-0"
          >
            <SheetTitle className="sr-only">Filters</SheetTitle>
            <div className="h-full">{filterRail}</div>
          </SheetContent>
        </Sheet>
      )}

      {/* Compact detail sheet (< lg) */}
      {detailVisible && isCompact && (
        <Sheet
          open
          onOpenChange={(open) => {
            if (!open) onDetailClose?.();
          }}
        >
          <SheetContent
            side="right"
            hideClose
            className="w-[92vw] max-w-md overflow-y-auto p-0"
          >
            <SheetTitle className="sr-only">Details</SheetTitle>
            <div className="h-full">{detail}</div>
          </SheetContent>
        </Sheet>
      )}

      {/* Compact secondary-panel sheet (< lg) */}
      {secondaryVisible && isCompact && (
        <Sheet
          open
          onOpenChange={(open) => {
            if (!open) onSecondaryClose?.();
          }}
        >
          <SheetContent
            side="left"
            hideClose
            className="w-[85vw] max-w-sm overflow-y-auto p-0"
          >
            <SheetTitle className="sr-only">Customize</SheetTitle>
            <div className="h-full">{secondaryPanel}</div>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
