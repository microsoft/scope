// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useAgentCatalog } from "@/components/AgentBadge";
import { hasExtensionCapableAgent } from "@/types";

/**
 * Whether VS Code extensions support is active in the portal: true only once
 * the agent catalog has loaded and at least one available agent declares
 * `supportsExtensions: true`. Fails closed while loading or on error.
 */
export function useExtensionsSupport(): { enabled: boolean; isLoading: boolean } {
  const { agents, isLoading } = useAgentCatalog();
  return { enabled: !isLoading && hasExtensionCapableAgent(agents), isLoading };
}
