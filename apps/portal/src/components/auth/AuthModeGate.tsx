// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState, type ReactNode } from "react";
import { QueryClient, useQuery } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { isAuthEnabled } from "@/lib/auth/msalInstance";
import { Button } from "@/components/ui/button";

export function AuthModeGate({ children, expectedEnabled = isAuthEnabled }: {
  children: ReactNode;
  expectedEnabled?: boolean;
}) {
  // Account changes clear application queries, not the deployment-mode check.
  const [client] = useState(() => new QueryClient());
  const { data, error, isPending, refetch } = useQuery({
    queryKey: ["api-auth-mode"],
    queryFn: ({ signal }) => api.getAuthMode({
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    }),
    retry: (count, cause) => count < 1 && (cause instanceof TypeError ||
      cause instanceof DOMException && cause.name === "TimeoutError" ||
      cause instanceof ApiError && (cause.status === 429 || cause.status >= 500)),
    retryDelay: 1_000,
    refetchInterval: 10_000,
    refetchIntervalInBackground: true,
    gcTime: 0,
  }, client);

  if (isPending) return <main className="p-10">Checking authentication configuration...</main>;
  if (error || data?.authEnabled !== expectedEnabled) return <main className="p-10" role="alert">
    <h1 className="text-lg font-semibold">Authentication configuration unavailable or mismatched</h1>
    <p>Set the same authentication mode on the API and Portal, then restart both services.</p>
    {error && <p>{error.message}</p>}
    <Button onClick={() => { void refetch(); }}>Retry</Button>
  </main>;
  return <>{children}</>;
}
