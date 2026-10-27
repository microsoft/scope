// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useLayoutEffect, useMemo } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useSelectedProjectId } from "@/contexts/ProjectContext";
import { getApiSessionSignal } from "@/lib/api-client";

const accountKeys = new WeakMap<AbortSignal, string>();

export function useArtifactSession(resource: string) {
  const { account, user, isReady } = useAuth();
  const projectId = useSelectedProjectId();
  const accountSignal = getApiSessionSignal();
  if (accountSignal && !accountKeys.has(accountSignal)) accountKeys.set(accountSignal, crypto.randomUUID());
  const session = useMemo(() => ({
    resource, projectId, ready: isReady && !!projectId, controller: new AbortController(),
    accountSignal,
    key: [resource, projectId, user?.id, account?.homeAccountId, account?.localAccountId,
      account?.tenantId, account?.environment, accountSignal ? accountKeys.get(accountSignal) : undefined],
  }), [
    resource, projectId, isReady, user?.id, account?.homeAccountId,
    account?.localAccountId, account?.tenantId, account?.environment, accountSignal,
  ]);
  useLayoutEffect(() => {
    const controller = new AbortController();
    session.controller = controller;
    const cancel = () => controller.abort();
    if (session.accountSignal?.aborted) cancel();
    session.accountSignal?.addEventListener("abort", cancel, { once: true });
    return () => {
      session.accountSignal?.removeEventListener("abort", cancel);
      controller.abort();
    };
  }, [session]);
  return session;
}
