// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Gates all app providers and routes until Scope accepts the MSAL account.
 *
 * Signed-out users are NOT auto-redirected to the IdP. Instead we render a
 * minimal placeholder page (a real landing page will replace it later) with a
 * "Log in" button; the interactive redirect only starts when the user clicks it.
 *
 * When the Portal auth config is missing (a production build without the
 * `VITE_AUTH_*` env vars), we render a clear configuration error instead of
 * bouncing into a broken redirect loop.
 */
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { isAuthConfigured, isAuthEnabled } from "@/lib/auth/msalInstance";
import { ApiError } from "@/lib/api";

function AuthPending({ label }: { label: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <div
          className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground"
          aria-hidden
        />
        <p className="text-sm">{label}</p>
      </div>
    </div>
  );
}

/**
 * Placeholder shown to signed-out users. Intentionally minimal — a real landing
 * page will replace it later. Its only job for now is to let the user start
 * sign-in explicitly (no automatic redirect).
 */
function Landing() {
  const { login } = useAuth();
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <Button onClick={() => void login()}>Log in</Button>
    </div>
  );
}

function NotConfigured() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="max-w-md text-center">
        <h1 className="text-lg font-semibold text-foreground">
          Authentication not configured
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This build is missing its identity-provider configuration
          (<code>VITE_AUTH_*</code>). Set the Entra ID values at build time and
          redeploy.
        </p>
      </div>
    </div>
  );
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { status, error, isReady, isAuthenticated, login, logout, retry } = useAuth();

  // Auth feature disabled → no gate at all; render the app as-is.
  if (!isAuthEnabled) {
    return <>{children}</>;
  }

  if (!isAuthConfigured) {
    return <NotConfigured />;
  }

  if (isReady && isAuthenticated) {
    return <>{children}</>;
  }

  if (status === "resolving") {
    return <AuthPending label="Connecting to Scope…" />;
  }

  if (status === "denied" || status === "error") {
    const code = error instanceof ApiError ? error.code : undefined;
    const notEnrolled = code === "user_not_enrolled";
    const disabled = code === "user_disabled";
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6">
        <div role="alert" className="max-w-md text-center">
          <h1 className="text-lg font-semibold text-foreground">
            {notEnrolled ? "Sign in to join Scope" : disabled ? "Account disabled"
              : status === "denied" ? "Access denied" : "Unable to connect to Scope"}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {notEnrolled ? "This account is not enrolled. Log in explicitly to create your Scope profile."
              : disabled ? "Your Scope account is disabled. Contact an administrator."
              : status === "denied" ? "Your account does not have access to Scope."
              : "Scope could not verify your account. Please try again."}
          </p>
          <div className="mt-4 flex justify-center gap-2">
            {notEnrolled && <Button onClick={() => void login()}>Log in</Button>}
            {status === "error" && <Button onClick={retry}>Retry</Button>}
            <Button variant="outline" onClick={() => void logout()}>Sign out</Button>
          </div>
        </div>
      </div>
    );
  }

  return <Landing />;
}
