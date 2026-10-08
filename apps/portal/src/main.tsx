// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Scope Portal - Application entrypoint
// Renders the React app with routing and query client
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
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: 1,
    },
  },
});

// Wire the API transport to MSAL, then complete any in-flight redirect sign-in
// before the first render so components see a settled auth state. MSAL must be
// initialized before <MsalProvider> mounts.
wireApiAuth();
initializeAuth().finally(() => {
  createRoot(document.getElementById("root")!).render(
    <QueryClientProvider client={queryClient}>
      <MsalProvider instance={msalInstance}>
        <AuthProvider>
          <ThemeProvider>
            {/* Gate App's favicon effect and eager providers, not just routes. */}
            <RequireAuth>
              <FeatureFlagProvider>
                <ProjectProvider>
                  <BrowserRouter>
                    <App />
                    <Toaster />
                  </BrowserRouter>
                </ProjectProvider>
              </FeatureFlagProvider>
            </RequireAuth>
          </ThemeProvider>
        </AuthProvider>
      </MsalProvider>
    </QueryClientProvider>
  );
});
