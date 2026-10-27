// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Navigate } from "react-router-dom";
import type { ReactNode } from "react";
import { useExtensionsSupport } from "@/hooks/useExtensionsSupport";

/**
 * Route guard for the VS Code extensions pages: renders nothing while the
 * agent catalog loads, then redirects to /statistics unless at least one
 * available agent supports extensions.
 */
export function ExtensionsRoute({ children }: { children: ReactNode }) {
  const { enabled, isLoading } = useExtensionsSupport();

  if (isLoading) return null;
  if (!enabled) return <Navigate to="/statistics" replace />;

  return <>{children}</>;
}
