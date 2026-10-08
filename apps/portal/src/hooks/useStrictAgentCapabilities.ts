// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export function useStrictAgentCapabilities(): boolean {
  const { data } = useQuery({
    queryKey: ["system-version"],
    queryFn: api.getVersion,
    staleTime: Infinity,
    retry: false,
  });

  return data?.strictAgentCapabilities === true;
}
