// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { FeatureFlag } from "@/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Settings } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";
import { PlatformAdministrators } from "@/components/PlatformAdministrators";

export function Admin() {
  const queryClient = useQueryClient();
  const { authEnabled, isReady, user } = useAuth();
  const canManageIdentities = authEnabled && isReady && Boolean(user?.capabilities?.platformAdmin);

  const { data: flags = [], isLoading } = useQuery({
    queryKey: ["feature-flags"],
    queryFn: api.listFeatureFlags,
  });

  const updateMutation = useMutation({
    mutationFn: ({ key, enabled }: { key: string; enabled: boolean }) =>
      api.updateFeatureFlag(key, enabled),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["feature-flags"] });
      toast.success("Feature flag updated");
    },
    onError: (error: Error) => {
      toast.error(`Failed to update flag: ${error.message}`);
    },
  });

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center gap-2">
        <Settings className="h-6 w-6" />
        <h1 className="text-2xl font-bold">Admin</h1>
      </div>

      {canManageIdentities && <PlatformAdministrators />}

      {/* Feature Flags card */}
      <Card>
        <CardHeader>
          <CardTitle>Feature Flags</CardTitle>
          <CardDescription>
            Control which sections are visible in the portal navigation. Disabled features are hidden from the nav bar and their routes redirect to Statistics.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="flex items-center justify-between">
                  <Skeleton className="h-5 w-32" />
                  <Skeleton className="h-5 w-9" />
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-4">
              {flags.map((flag: FeatureFlag) => (
                <div
                  key={flag.key}
                  className="flex items-center justify-between rounded-lg border p-4"
                >
                  <div className="space-y-0.5">
                    <Label htmlFor={`flag-${flag.key}`} className="text-base font-medium">
                      {flag.label}
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      Feature key: <code className="text-xs">{flag.key}</code>
                    </p>
                  </div>
                  <Switch
                    id={`flag-${flag.key}`}
                    checked={flag.enabled}
                    onCheckedChange={(checked) =>
                      updateMutation.mutate({ key: flag.key, enabled: checked })
                    }
                    disabled={updateMutation.isPending}
                  />
                </div>
              ))}
              {flags.length === 0 && (
                <p className="text-sm text-muted-foreground">No feature flags configured.</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
