// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface VersionInfo {
  commit: string;
  buildTime: string;
}

interface ReadinessInfo {
  status: string;
  migrations: { ready: boolean; applied: string[]; pending: string[]; totalApplied: number };
}

export function VersionFooter() {
  const [apiVersion, setApiVersion] = useState<VersionInfo | null>(null);
  const [readiness, setReadiness] = useState<ReadinessInfo | null>(null);
  const [apiReachable, setApiReachable] = useState(true);

  useEffect(() => {
    api.getVersion()
      .then(setApiVersion)
      .catch(() => {
        setApiVersion(null);
        setApiReachable(false);
      });
    api.getReadiness()
      .then(setReadiness)
      .catch(() => setReadiness(null));
  }, []);

  const portalCommit = __GIT_COMMIT__;
  const portalBuildTime = __BUILD_TIME__;
  const gitBranch = __GIT_BRANCH__;

  const formatDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  };

  const shortCommit = (commit: string) => {
    if (commit === "development" || commit === "unknown") return commit;
    return commit.slice(0, 7);
  };

  return (
    <footer className="shrink-0 border-t bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
      <div className="flex flex-col items-center gap-1 text-center">
        <p className="text-[11px]">
          This is an AI evaluation platform. Do not attribute human qualities or intent
          to it. AI-generated content may be inaccurate. Review and edit generated
          output before use.
        </p>
        <div className="flex flex-wrap justify-center gap-x-6 gap-y-1">
          <a
            href="https://github.com/microsoft/scope/blob/main/website/src/content/docs/resources/data-collection.md"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            Data collection and privacy
          </a>
          {gitBranch && (
            <span>
              Branch: <code className="font-mono">{gitBranch}</code>
            </span>
          )}
          <span>
            Portal: <code className="font-mono">{shortCommit(portalCommit)}</code>{" "}
            <span className="text-muted-foreground/70">
              ({formatDate(portalBuildTime)})
            </span>
          </span>
          {apiVersion ? (
            <span>
              API: <code className="font-mono">{shortCommit(apiVersion.commit)}</code>{" "}
              <span className="text-muted-foreground/70">
                ({formatDate(apiVersion.buildTime)})
              </span>
            </span>
          ) : !apiReachable ? (
            <span className="text-destructive">API: unavailable</span>
          ) : null}
          {readiness && (
            <span>
              DB:{" "}
              <code className="font-mono">
                v
                {readiness.migrations.totalApplied ??
                  readiness.migrations.applied.length}
              </code>
              {readiness.migrations.pending.length > 0 && (
                <span className="ml-1 text-yellow-600 dark:text-yellow-400">
                  · {readiness.migrations.pending.length} pending
                </span>
              )}
            </span>
          )}
        </div>
      </div>
    </footer>
  );
}
