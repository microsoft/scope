// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState, useMemo, useEffect, Fragment } from "react";
import { Link, useLocation, Outlet, matchPath } from "react-router-dom";
import { cn } from "@/lib/utils";
import {
  Activity,
  Plus,
  List,
  FlaskConical,
  BarChart3,
  Tags,
  FileText,
  KeyRound,
  Bot,
  Server,
  Lightbulb,
  Cpu,
  MessageSquareText,
  Settings,
  Menu,
  BookOpen,
  FolderGit2,
  FolderKanban,
  GitBranch,
  Plug,
  Puzzle,
  Boxes,
  SlidersHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTrigger,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { VersionFooter } from "./VersionFooter";
import { ThemeToggle } from "./ThemeToggle";
import { UserMenu } from "./UserMenu";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { useFeatureFlags } from "@/contexts/FeatureFlagContext";
import { useProjectContext } from "@/contexts/ProjectContext";

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** When set, this nav item is only shown if the corresponding feature flag is enabled */
  featureKey?: string;
}

interface NavGroup {
  id: string;
  /** Human label shown in the mobile sheet and as the tooltip group hint. */
  label: string;
  items: NavItem[];
  /**
   * When true, every item in this group points to a project-scoped page (routes
   * wrapped in `ProjectGate` in App.tsx), so the whole group is hidden until a
   * project is selected. Global groups (e.g. Platform) omit this and stay
   * visible without a selection.
   */
  scoped?: boolean;
}

/**
 * Sidebar nav grouped by domain noun:
 *   Activity     - what happened (runs and their outputs)
 *   Library      - content you author (tasks, criteria, profiles, ...)
 *   Integrations - project-scoped things you wire up (resources, MCP, extensions)
 *   Platform     - global infra shared across projects (agents, models, secrets)
 *
 * Activity, Library and Integrations are `scoped`: their pages live behind a
 * ProjectGate, so the sidebar hides them until a project is selected. Platform
 * is global - it lives at the tenant level and is shared by every project, so
 * it stays visible without a selection and is pinned last.
 *
 * The pinned Projects link (global) and the dev-only MDP view (scoped) are
 * rendered outside these groups; New Run and MDP are gated on the selection too.
 */
const navGroups: NavGroup[] = [
  {
    id: "activity",
    label: "Activity",
    scoped: true,
    items: [
      { to: "/runs", label: "Runs", icon: List },
      { to: "/statistics", label: "Statistics", icon: BarChart3 },
      { to: "/reports", label: "Reports", icon: FileText },
      { to: "/insights", label: "Insights", icon: Lightbulb },
    ],
  },
  {
    id: "library",
    label: "Library",
    scoped: true,
    items: [
      { to: "/task-prompts", label: "Prompts", icon: MessageSquareText },
      { to: "/criteria", label: "Criteria", icon: FlaskConical },
      { to: "/prompt-features", label: "Features", icon: Tags },
      { to: "/profiles", label: "Profiles", icon: SlidersHorizontal, featureKey: "profiles" },
      { to: "/skills", label: "Skills", icon: BookOpen, featureKey: "skills" },
      { to: "/codebases", label: "Codebases", icon: FolderGit2 },
    ],
  },
  {
    id: "resources",
    label: "Integrations",
    scoped: true,
    items: [
      { to: "/resources", label: "Resources", icon: Boxes },
      { to: "/mcp-servers", label: "MCP", icon: Server, featureKey: "mcp" },
      { to: "/extensions", label: "Extensions", icon: Puzzle, featureKey: "extensions" },
    ],
  },
  {
    // Global, non-project-scoped infra shared by every project. Pinned last so
    // it reads as tenant-level and stays clear of the project-scoped groups.
    id: "platform",
    label: "Platform",
    items: [
      { to: "/agents", label: "Agents", icon: Bot, featureKey: "agents" },
      { to: "/models", label: "Models", icon: Cpu, featureKey: "models" },
      { to: "/secrets", label: "Secrets", icon: KeyRound, featureKey: "tokens" },
    ],
  },
];

// Dev/diagnostic — pinned at the bottom of the primary nav, kept out of the
// noun groups above so it doesn't compete with the day-to-day pages.
const devNavItems: NavItem[] = [
  { to: "/criteria/mdp", label: "MDP", icon: GitBranch },
];

const SIDEBAR_EXPANDED_STORAGE_KEY = "scope:layout:sidebar-expanded";

/**
 * Routes that opt-in to the full-bleed list/detail layout (no `container`
 * max-width or vertical padding). The list page must render `<ListLayout>`.
 */
const FULL_BLEED_ROUTE_PATTERNS = [
  "/prompt-features",
  "/prompt-features/:id",
  "/agents",
  "/agents/:id",
  "/models",
  "/models/:id",
  "/runs",
  "/runs/:id/preview",
  "/task-prompts",
  "/criteria",
  "/insights",
  "/resources",
  "/mcp-servers",
  "/skills",
  "/extensions",
  "/profiles",
  "/secrets/keys",
  "/secrets/accounts",
  "/reports",
  "/reports/templates",
  "/projects",
];

interface SidebarIconLinkProps {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  active: boolean;
  expanded: boolean;
  external?: boolean;
  emphasized?: boolean;
}

function SidebarIconLink({
  to,
  label,
  icon: Icon,
  active,
  expanded,
  external,
  emphasized,
}: SidebarIconLinkProps) {
  const className = cn(
    "relative flex h-10 items-center rounded-md transition-colors",
    expanded ? "w-full justify-start gap-3 px-3" : "w-10 justify-center",
    emphasized
      ? "bg-action text-action-foreground shadow-sm hover:bg-action/90"
      : active
        ? "bg-accent text-foreground"
        : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
  );
  const content = (
    <>
      {active && !emphasized && (
        <span
          className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r bg-primary"
          aria-hidden
        />
      )}
      <Icon className="h-5 w-5 shrink-0" />
      {expanded && <span className="truncate text-sm font-medium">{label}</span>}
    </>
  );

  const link = external ? (
    <a
      href={to}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      aria-label={expanded ? undefined : label}
    >
      {content}
    </a>
  ) : (
    <Link to={to} className={className} aria-label={expanded ? undefined : label}>
      {content}
    </Link>
  );

  if (expanded) {
    return link;
  }

  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        {link}
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

export function Layout() {
  const location = useLocation();
  const { isFeatureEnabled } = useFeatureFlags();
  const { hasProject } = useProjectContext();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sidebarExpanded, setSidebarExpanded] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SIDEBAR_EXPANDED_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_EXPANDED_STORAGE_KEY, sidebarExpanded ? "1" : "0");
    } catch {
      // Ignore unavailable storage so navigation remains usable.
    }
  }, [sidebarExpanded]);

  const filterByFeature = (items: NavItem[]) =>
    items.filter((item) => !item.featureKey || isFeatureEnabled(item.featureKey));

  const visibleGroups = useMemo(
    () =>
      navGroups
        .map((g) => ({ ...g, items: filterByFeature(g.items) }))
        // Scoped groups only appear once a project is in use; global groups
        // (e.g. Platform) always show. Empty groups are dropped so no stray
        // separator/label is left behind.
        .filter((g) => (hasProject || !g.scoped) && g.items.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isFeatureEnabled, hasProject],
  );
  // MDP points at /criteria/mdp (project-scoped), so hide the Dev section until
  // a project is selected.
  const visibleDevItems = hasProject ? filterByFeature(devNavItems) : [];

  const isFullBleed = useMemo(
    () =>
      FULL_BLEED_ROUTE_PATTERNS.some((pattern) =>
        matchPath({ path: pattern, end: true }, location.pathname),
      ),
    [location.pathname],
  );

  const adminActive = location.pathname === "/admin";

  return (
    <TooltipProvider delayDuration={150} skipDelayDuration={300}>
      <div
        className={cn(
          "flex flex-col bg-background",
          isFullBleed ? "h-screen overflow-hidden" : "min-h-screen",
        )}
      >
        {/* Top header — logo on the left, controls on the right */}
        <header className="sticky top-0 z-50 flex h-12 shrink-0 items-center justify-between border-b border-border/60 bg-background/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          {/* Logo doubles as "home": route to `/`, whose HomeRoute clears the
              active project and shows the project picker. De-scoping lives in the
              route (not this click handler), so the logo is a plain link — any
              way of reaching `/` behaves the same, and open-in-new-tab needs no
              special-casing. */}
          <Link
            to="/"
            className="flex items-center gap-2 font-bold"
            aria-label="Scope home"
          >
            <Activity className="h-5 w-5 text-action" />
            <span>Scope</span>
          </Link>
          <div className="flex items-center gap-1">
            <ProjectSwitcher />
            <ThemeToggle />
            <UserMenu />
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          {/* Desktop sidebar — collapsible, sticks below the top header */}
          <aside
            className={cn(
              "sticky top-12 z-30 hidden h-[calc(100vh-3rem)] shrink-0 flex-col self-start overflow-y-auto overscroll-contain border-r border-border/60 bg-card/40 transition-[width] duration-200 ease-out [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:flex",
              sidebarExpanded ? "w-56" : "w-14 items-center",
            )}
            aria-label="Primary navigation"
          >
            <div
              className={cn(
                "flex w-full border-b border-border/60 p-2",
                sidebarExpanded ? "justify-end" : "justify-center",
              )}
            >
              <Tooltip delayDuration={150}>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9"
                    onClick={() => setSidebarExpanded((expanded) => !expanded)}
                    aria-label={sidebarExpanded ? "Collapse sidebar" : "Expand sidebar"}
                    aria-expanded={sidebarExpanded}
                  >
                    {sidebarExpanded ? (
                      <PanelLeftClose className="h-5 w-5" />
                    ) : (
                      <PanelLeftOpen className="h-5 w-5" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  {sidebarExpanded ? "Collapse sidebar" : "Expand sidebar"}
                </TooltipContent>
              </Tooltip>
            </div>

            {/* Primary nav */}
            <nav
              className={cn(
                "flex w-full flex-col gap-1 py-3",
                sidebarExpanded ? "px-2" : "items-center",
              )}
            >
              {/* New Run — emphasized primary CTA. Scoped (submitting a run needs
                  a project), so it's hidden along with its divider until one is
                  selected; Projects then becomes the first pinned item. */}
              {hasProject && (
                <>
                  <SidebarIconLink
                    to="/runs/new"
                    label="New Run"
                    icon={Plus}
                    active={location.pathname === "/runs/new"}
                    expanded={sidebarExpanded}
                    emphasized
                  />
                  <div
                    className={cn("my-1 h-px bg-border/60", sidebarExpanded ? "w-full" : "w-6")}
                    aria-hidden
                  />
                </>
              )}
              {/* Projects — pinned above the Activity group; the active project scopes everything below */}
              <SidebarIconLink
                to="/projects"
                label="Projects"
                icon={FolderKanban}
                active={location.pathname.startsWith("/projects")}
                expanded={sidebarExpanded}
              />
              <div
                className={cn("my-1 h-px bg-border/60", sidebarExpanded ? "w-full" : "w-6")}
                aria-hidden
              />
              {visibleGroups.map((group, groupIdx) => (
                <Fragment key={group.id}>
                  {groupIdx > 0 && (
                    <div
                      className={cn(
                        "my-1 h-px bg-border/60",
                        sidebarExpanded ? "w-full" : "w-6",
                      )}
                      role="separator"
                      aria-label={group.label}
                    />
                  )}
                  {sidebarExpanded && (
                    <div className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {group.label}
                    </div>
                  )}
                  {group.items.map((item) => {
                    const isActive = location.pathname.startsWith(item.to);
                    return (
                      <SidebarIconLink
                        key={item.to}
                        to={item.to}
                        label={item.label}
                        icon={item.icon}
                        active={isActive}
                        expanded={sidebarExpanded}
                      />
                    );
                  })}
                </Fragment>
              ))}
              {visibleDevItems.length > 0 && (
                <>
                  <div
                    className={cn("my-1 h-px bg-border/60", sidebarExpanded ? "w-full" : "w-6")}
                    aria-hidden
                  />
                  {sidebarExpanded && (
                    <div className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Dev
                    </div>
                  )}
                  {visibleDevItems.map((item) => {
                    const isActive = location.pathname.startsWith(item.to);
                    return (
                      <SidebarIconLink
                        key={item.to}
                        to={item.to}
                        label={item.label}
                        icon={item.icon}
                        active={isActive}
                        expanded={sidebarExpanded}
                      />
                    );
                  })}
                </>
              )}
            </nav>

            {/* Footer: API docs + Admin — pinned to bottom when there's room, scrolls with content otherwise */}
            <div
              className={cn(
                "mt-auto flex w-full flex-col gap-1 border-t border-border/60 py-3",
                sidebarExpanded ? "px-2" : "items-center",
              )}
            >
              <SidebarIconLink
                to="/api-docs"
                label="API Documentation"
                icon={Plug}
                active={false}
                expanded={sidebarExpanded}
                external
              />
              <SidebarIconLink
                to="/admin"
                label="Admin"
                icon={Settings}
                active={adminActive}
                expanded={sidebarExpanded}
              />
            </div>
          </aside>

          {/* Main column (mobile header + content + version footer) */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {/* Mobile nav bar (hamburger only, logo lives in top header) */}
            <div className="flex h-10 items-center border-b border-border/60 bg-background/95 px-2 backdrop-blur sm:hidden">
              <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
                <SheetTrigger asChild>
                  <Button variant="ghost" size="icon">
                    <Menu className="h-5 w-5" />
                    <span className="sr-only">Toggle navigation</span>
                  </Button>
                </SheetTrigger>
                <SheetContent side="left" className="w-64 pt-10">
                  <SheetTitle className="sr-only">Navigation</SheetTitle>
                  <nav className="flex flex-col space-y-1">
                    {visibleGroups.map((group, groupIdx) => (
                      <Fragment key={group.id}>
                        <div
                          className={cn(
                            "px-3 pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground",
                            groupIdx > 0 && "pt-3",
                          )}
                        >
                          {group.label}
                        </div>
                        {group.items.map((item) => {
                          const isActive = location.pathname.startsWith(item.to);
                          return (
                            <Link
                              key={item.to}
                              to={item.to}
                              onClick={() => setMobileOpen(false)}
                              className={cn(
                                "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground",
                                isActive
                                  ? "bg-accent text-accent-foreground"
                                  : "text-muted-foreground",
                              )}
                            >
                              <item.icon className="h-4 w-4" />
                              {item.label}
                            </Link>
                          );
                        })}
                      </Fragment>
                    ))}
                    {visibleDevItems.length > 0 && (
                      <>
                        <div className="px-3 pb-1 pt-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                          Dev
                        </div>
                        {visibleDevItems.map((item) => {
                          const isActive = location.pathname.startsWith(item.to);
                          return (
                            <Link
                              key={item.to}
                              to={item.to}
                              onClick={() => setMobileOpen(false)}
                              className={cn(
                                "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground",
                                isActive
                                  ? "bg-accent text-accent-foreground"
                                  : "text-muted-foreground",
                              )}
                            >
                              <item.icon className="h-4 w-4" />
                              {item.label}
                            </Link>
                          );
                        })}
                      </>
                    )}
                    <div className="my-2 h-px bg-border/60" />
                    <a
                      href="/api-docs"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                    >
                      <Plug className="h-4 w-4" />
                      API Documentation
                    </a>
                    <Link
                      to="/admin"
                      onClick={() => setMobileOpen(false)}
                      className={cn(
                        "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground",
                        adminActive
                          ? "bg-accent text-accent-foreground"
                          : "text-muted-foreground",
                      )}
                    >
                      <Settings className="h-4 w-4" />
                      Admin
                    </Link>
                  </nav>
                </SheetContent>
              </Sheet>
            </div>

            {/* Main content */}
            <main
              className={cn(
                "flex-1 min-h-0",
                isFullBleed ? "flex flex-col" : "w-full px-6 py-6 lg:px-8",
              )}
            >
              <Outlet />
            </main>

            <VersionFooter />
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
