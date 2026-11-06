// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Gates all app providers and routes until Scope accepts the MSAL account.
 *
 * Signed-out users are NOT auto-redirected to the IdP. Instead we render a
 * branded welcome page with a "Log in" button; the interactive redirect only
 * starts when the user clicks it.
 *
 * When the Portal auth config is missing (a production build without the
 * `VITE_AUTH_*` env vars), we render a clear configuration error instead of
 * bouncing into a broken redirect loop.
 */
import { useState, type ReactNode } from "react";
import { Activity, ArrowRight, ArrowUpRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { isAuthConfigured, isAuthEnabled } from "@/lib/auth/msalInstance";
import { ApiError } from "@/lib/api";
import "./RequireAuth.css";

/** Keep the public welcome and account-resolution states in the website's visual world. */
function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="scope-login">
      <header className="scope-login-header">
        <a className="scope-login-brand" href="https://microsoft.github.io/scope/" aria-label="Scope website">
          <Activity size={28} aria-hidden="true" />
          <span>Scope</span>
        </a>
        <a className="scope-login-docs" href="https://microsoft.github.io/scope/introduction/what-is-scope/">
          Documentation <ArrowUpRight size={16} aria-hidden="true" />
        </a>
      </header>
      <main className="scope-login-main">
        <section className="scope-login-intro" aria-labelledby="scope-welcome">
          <h1 id="scope-welcome">
            Your product.<br />
            Their agents.<br />
            <span>The whole picture.</span>
          </h1>
          <p>
            Give coding agents the same task, define what good looks like,
            and see the evidence. That&apos;s Scope.
          </p>
          <p className="scope-login-note">Your tasks. Your criteria. Repeatable experiments.</p>
        </section>
        <section className="scope-login-panel" aria-label="Account access">
          {children}
        </section>
      </main>
      <footer className="scope-login-footer">
        <span>The agentic experience, measured.</span>
        <a href="https://github.com/microsoft/scope">
          Scope on GitHub <ArrowUpRight size={14} aria-hidden="true" />
        </a>
      </footer>
    </div>
  );
}

/** Surface redirect failures locally and prevent repeated sign-in submissions. */
function LoginAction() {
  const { login } = useAuth();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function startLogin() {
    if (pending) return;
    setPending(true);
    setFailed(false);
    try {
      await login();
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="scope-login-action">
      <Button className="scope-login-primary" disabled={pending} onClick={() => void startLogin()}>
        {pending ? <><Loader2 className="animate-spin motion-reduce:animate-none" size={18} aria-hidden="true" /> Opening sign-in…</>
          : <>Log in <ArrowRight size={18} aria-hidden="true" /></>}
      </Button>
      {pending && <p role="status">Taking you to your sign-in page…</p>}
      {failed && <p role="alert">Unable to start sign-in. Please try again.</p>}
    </div>
  );
}

function AuthPending({ label }: { label: string }) {
  return (
    <AuthShell>
      <div role="status" className="scope-login-pending">
        <Loader2 className="animate-spin motion-reduce:animate-none" size={26} aria-hidden="true" />
        <h2>{label}</h2>
        <p>We&apos;re checking your account and project access.</p>
      </div>
    </AuthShell>
  );
}

/** Sign-in remains explicit; visiting the welcome page never enrolls an account. */
function Landing() {
  return (
    <AuthShell>
      <h2>Welcome to Scope</h2>
      <p>Sign in to run experiments, explore results, and work with your team.</p>
      <LoginAction />
      <p className="scope-login-provider">You&apos;ll continue to your organization&apos;s sign-in page.</p>
      <div className="scope-login-first-time">
        <h3>First time here?</h3>
        <p>Log in to create your Scope profile. A project administrator can then give you access.</p>
      </div>
    </AuthShell>
  );
}

function NotConfigured() {
  return (
    <AuthShell>
      <div role="alert">
        <h2>
          Authentication not configured
        </h2>
        <p>
          This build is missing its identity-provider configuration
          (<code>VITE_AUTH_*</code>). Set the Entra ID values at build time and
          redeploy.
        </p>
      </div>
    </AuthShell>
  );
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { status, error, isReady, isAuthenticated, logout, retry } = useAuth();

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
      <AuthShell>
        <div role="alert">
          <h2>
            {notEnrolled ? "Sign in to join Scope" : disabled ? "Account disabled"
              : status === "denied" ? "Access denied" : "Unable to connect to Scope"}
          </h2>
          <p>
            {notEnrolled ? "This account is not enrolled. Log in explicitly to create your Scope profile."
              : disabled ? "Your Scope account is disabled. Contact an administrator."
              : status === "denied" ? "Your account does not have access to Scope."
              : "Scope could not verify your account. Please try again."}
          </p>
          <div className="scope-login-recovery">
            {notEnrolled && <LoginAction />}
            {status === "error" && <Button className="scope-login-primary" onClick={retry}>Retry</Button>}
            <Button variant="outline" onClick={() => void logout()}>Sign out</Button>
          </div>
        </div>
      </AuthShell>
    );
  }

  return <Landing />;
}
