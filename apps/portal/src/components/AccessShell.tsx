// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useEffect, type ReactNode } from "react";
import { Link, matchRoutes, Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { useProjectContext } from "@/contexts/ProjectContext";

const platformRoutes = ["/agents/*", "/models/*", "/secrets/*", "/admin/*", "/access"].map(path => ({ path }));

export function AccessShell({ children }: { children: ReactNode }) {
  const { user, authEnabled, isReady } = useAuth();
  const { selectedProjectId, setSelectedProjectId } = useProjectContext();
  const location = useLocation();
  const platformMatch = matchRoutes(platformRoutes, location)?.[0];
  const platformRoute = Boolean(platformMatch);
  const projectInventoryRoute = Boolean(matchRoutes([{ path: "/projects" }], location));
  const capabilities = user?.capabilities;
  const accessRoute = platformMatch?.route.path === "/access";
  const accessProjectId = new URLSearchParams(location.search).get("projectId");
  const projectMembershipAdmin = Boolean(accessRoute && accessProjectId && capabilities?.memberships.some(
    m => m.projectId === accessProjectId && m.role === "admin" && m.permissions.includes("members:write"),
  ));
  const member = capabilities?.memberships.some(m => m.projectId === selectedProjectId);
  useEffect(() => {
    if (authEnabled && selectedProjectId && !member) setSelectedProjectId(undefined);
  }, [authEnabled, selectedProjectId, member, setSelectedProjectId]);
  if (!authEnabled) {
    return platformMatch?.route.path === "/access"
      ? <main className="p-10">Access administration requires authentication to be enabled.</main>
      : <>{children}</>;
  }
  if (!isReady || !capabilities) return <main className="p-10">Access capabilities are unavailable.</main>;
  // Keep enrolled accounts in the normal app without mounting inaccessible pages.
  if (!capabilities.platformAdmin && !capabilities.memberships.length && !projectInventoryRoute) {
    return <Navigate to="/projects" replace />;
  }
  if (platformRoute && !capabilities.platformAdmin && !projectMembershipAdmin) return <main className="p-10">Platform administration is not permitted.</main>;
  if (!platformRoute && location.pathname.endsWith("/new") && !capabilities.memberships.some(m => m.projectId === selectedProjectId && m.permissions.includes("content:write"))) {
    return <main className="p-10">Your project role permits reading only.</main>;
  }
  return <>
    {capabilities.platformAdmin && <div className="border-b px-4 py-2 text-sm"><Link to="/access">Access administration</Link></div>}
    {!platformRoute && selectedProjectId && !member ? <main className="p-10">Project access has changed. Select an accessible project.</main> : children}
  </>;
}
