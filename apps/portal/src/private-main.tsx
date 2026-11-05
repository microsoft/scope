// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MsalProvider } from "@azure/msal-react";
import { App } from "./App";
import { FeatureFlagProvider } from "@/contexts/FeatureFlagContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { AuthProvider } from "@/contexts/AuthContext";
import { ProjectProvider } from "@/contexts/ProjectContext";
import { Toaster } from "@/components/ui/sonner";
import { RequireAuth } from "@/components/auth/RequireAuth";
import { msalInstance, initializeAuth } from "@/lib/auth/msalInstance";
import { wireApiAuth } from "@/lib/auth/wireApiAuth";

export async function mountPrivateApp() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 5_000, retry: 1 } },
  });
  wireApiAuth();
  try {
    await initializeAuth();
  } finally {
    createRoot(document.getElementById("root")!).render(
      <QueryClientProvider client={queryClient}>
        <MsalProvider instance={msalInstance}>
          <AuthProvider>
            <ThemeProvider>
              <RequireAuth>
                <FeatureFlagProvider>
                  <ProjectProvider>
                    <BrowserRouter><App /><Toaster /></BrowserRouter>
                  </ProjectProvider>
                </FeatureFlagProvider>
              </RequireAuth>
            </ThemeProvider>
          </AuthProvider>
        </MsalProvider>
      </QueryClientProvider>,
    );
  }
}
