// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Navigate } from "react-router-dom";
import { useFeatureFlags } from "@/contexts/FeatureFlagContext";
import type { ReactNode } from "react";

interface FeatureRouteProps {
  featureKey: string;
  failClosed?: boolean;
  children: ReactNode;
}

/** Route guard that redirects to /statistics when a feature flag is disabled */
export function FeatureRoute({ featureKey, failClosed = false, children }: FeatureRouteProps) {
  const { isFeatureEnabled, isFeatureEnabledFailClosed } = useFeatureFlags();

  const enabled = failClosed
    ? isFeatureEnabledFailClosed(featureKey)
    : isFeatureEnabled(featureKey);
  if (!enabled) {
    return <Navigate to="/statistics" replace />;
  }

  return <>{children}</>;
}
