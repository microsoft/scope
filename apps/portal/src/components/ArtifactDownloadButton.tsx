// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { Button, type ButtonProps } from "@/components/ui/button";
import { useArtifactSession } from "@/hooks/use-artifact-session";
import { downloadArtifact, downloadBatchArtifacts } from "@/lib/artifact-delivery";

interface Props extends Omit<ButtonProps, "onClick" | "asChild"> {
  url: string;
  filename?: string;
  batchIds?: readonly string[];
  onPendingChange?: (pending: boolean) => void;
}

export function ArtifactDownloadButton({ url, filename, batchIds, onPendingChange, disabled, children, ...props }: Props) {
  const session = useArtifactSession(batchIds ? `${url}#${JSON.stringify(batchIds)}` : url);
  const operation = useRef<{ session: typeof session; controller: AbortController } | null>(null);
  const [pending, setPending] = useState<typeof session | null>(null);
  const busy = pending === session;
  return (
    <>
      <Button {...props} type="button" disabled={disabled || !session.ready || busy} aria-busy={busy}
        onClick={(event) => {
          event.stopPropagation();
          if (operation.current?.session === session && !operation.current.controller.signal.aborted) return;
          const controller = new AbortController();
          operation.current = { session, controller };
          const signal = AbortSignal.any([controller.signal, session.controller.signal]);
          setPending(session);
          onPendingChange?.(true);
          const download = batchIds ? downloadBatchArtifacts(batchIds, session.projectId!, signal)
            : downloadArtifact(url, session.projectId!, signal, filename);
          void download.catch((cause: unknown) => {
            if (!signal.aborted) toast.error(cause instanceof Error ? cause.message : "Unable to download artifact.");
          }).finally(() => {
            if (operation.current?.controller === controller) {
              operation.current = null;
              onPendingChange?.(false);
            }
            if (!session.controller.signal.aborted) setPending(current => current === session ? null : current);
          });
        }}>
        {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
        {children}
      </Button>
      {busy && <Button type="button" variant="ghost" size="icon" title="Cancel download"
        onClick={(event) => { event.stopPropagation(); operation.current?.controller.abort(); }}>
        <X className="h-4 w-4" /><span className="sr-only">Cancel download</span>
      </Button>}
    </>
  );
}
