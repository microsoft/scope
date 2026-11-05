// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { SharedRunPage } from "@/pages/SharedRun";

export function mountPublicApp() {
  const robots = document.createElement("meta");
  robots.name = "robots";
  robots.content = "noindex, nofollow, noarchive";
  document.head.append(robots);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  createRoot(document.getElementById("root")!).render(
    <QueryClientProvider client={queryClient}><ThemeProvider><SharedRunPage /></ThemeProvider></QueryClientProvider>,
  );
}
