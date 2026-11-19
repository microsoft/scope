// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Card, CardContent } from "@/components/ui/card";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useArtifactSession } from "@/hooks/use-artifact-session";
import { openAuthenticatedMedia, type MediaBridge } from "@/lib/authenticated-media";

interface VideoPlayerProps {
  src: string;
  label?: string;
}

function stopVideo(element: HTMLVideoElement | null) {
  if (element) { element.pause(); element.removeAttribute("src"); element.load(); }
}

export function VideoPlayer({ src, label }: VideoPlayerProps) {
  const session = useArtifactSession(src);
  const video = useRef<HTMLVideoElement>(null);
  const activeBridge = useRef<MediaBridge>(undefined);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{ session: typeof session; url?: string; error?: string }>();
  const current = state?.session === session ? state : undefined;
  useEffect(() => {
    if (!session.ready) return;
    if (typeof AbortSignal.any !== "function") {
      setState({ session, error: "Authenticated video requires a browser with abortable streaming support." });
      return;
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([session.controller.signal, controller.signal]);
    let bridge: MediaBridge | undefined;
    const element = video.current;
    const stop = () => stopVideo(element);
    signal.addEventListener("abort", stop, { once: true });
    void openAuthenticatedMedia(src, session.projectId!, signal, error => {
      if (!signal.aborted) { stop(); setState({ session, error }); }
    }).then(result => {
      if (signal.aborted) result.close();
      else { bridge = result; activeBridge.current = result; setState({ session, url: result.url }); }
    }).catch((cause: unknown) => {
      if (!signal.aborted) setState({ session, error: cause instanceof Error ? cause.message : "Unable to open recording." });
    });
    return () => {
      controller.abort();
      signal.removeEventListener("abort", stop);
      bridge?.close();
      if (activeBridge.current === bridge) activeBridge.current = undefined;
      stop();
    };
  }, [session, src, retry]);
  return (
    <Card>
      <CardContent className="p-4">
        {label && (
          <h4 className="text-sm font-medium mb-2">{label}</h4>
        )}
        {current?.error ? <div role="alert" className="space-y-2 text-sm text-destructive">
          <p>{current.error}</p>
          <Button variant="outline" size="sm" onClick={() => { setState(undefined); setRetry(value => value + 1); }}>Retry recording</Button>
        </div> : <video
          ref={video}
          controls
          aria-label={label ?? "Session recording"}
          preload="metadata"
          className="w-full rounded-md bg-black"
          src={current?.url}
          onError={() => {
            activeBridge.current?.close();
            stopVideo(video.current);
            setState(previous => previous?.session === session && previous.error ? previous
              : { session, error: "Unable to play the recording. Reopen it to retry authenticated delivery." });
          }}
        >
          Your browser does not support the video tag.
        </video>}
      </CardContent>
    </Card>
  );
}
