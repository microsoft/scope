// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { SharedRunArtifact } from "shared/run-sharing";
import { SharedRunView, SharedRunUnavailable, SharedText } from "@/components/run-sharing/SharedRunView";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { publicRunApi, SharedRunError, tokenFromFragment } from "@/lib/public-run-api";

function SharedLogs({ token }: { token: string }) {
  const query = useQuery({
    queryKey: ["public-run-logs", token], queryFn: ({ signal }) => publicRunApi.logs(token, signal),
    retry: false, gcTime: 0, refetchInterval: 15_000,
  });
  if (query.error) return <p role="alert" className="text-sm text-destructive">{query.error.message}</p>;
  if (!query.data) return <p role="status" className="text-sm text-muted-foreground">Loading persisted logs...</p>;
  return <div className="space-y-3">
    {query.data.truncated && <p role="status" className="text-sm text-muted-foreground">Showing a bounded tail of persisted logs; some entries are omitted.</p>}
    <SharedText>{query.data.events.length ? query.data.events.map((event) =>
      `${event.timestamp} [${event.level}] ${event.message}${event.data ? ` ${JSON.stringify(event.data)}` : ""}`).join("\n") : "No persisted logs yet."}</SharedText>
  </div>;
}

function SharedReports({ token }: { token: string }) {
  const query = useInfiniteQuery({
    queryKey: ["public-run-reports", token],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => publicRunApi.reports(token, pageParam, signal),
    getNextPageParam: (last) => last.next ?? undefined,
    retry: false, gcTime: 0, refetchInterval: 15_000,
  });
  if (query.error) return <p role="alert" className="text-sm text-destructive">{query.error.message}</p>;
  if (!query.data) return <p role="status" className="text-sm text-muted-foreground">Loading shared reports...</p>;
  const reports = [...new Map(query.data.pages.flatMap((page) => page.data).map((report) => [report.id, report])).values()];
  return <div className="space-y-4">
    {reports.length === 0 && <p className="text-sm text-muted-foreground">No completed reports verified for this attempt. Legacy reports without attempt provenance are not shared.</p>}
    {reports.map((report) => <Card key={report.id}>
      <CardHeader><CardTitle className="text-base">{report.label}</CardTitle></CardHeader>
      <CardContent className="prose prose-sm max-w-none dark:prose-invert">
        <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
          a: ({ children }) => <span>{children}</span>,
          img: ({ alt }) => <span>[Image omitted{alt ? `: ${alt}` : ""}]</span>,
        }}>{report.content}</ReactMarkdown>
      </CardContent>
    </Card>)}
    {query.hasNextPage && <Button variant="outline" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>Load more reports</Button>}
  </div>;
}

function ArtifactActions({ token, artifact }: { token: string; artifact: SharedRunArtifact }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => () => { if (videoUrl) URL.revokeObjectURL(videoUrl); }, [videoUrl]);

  async function load(preview: boolean) {
    setPending(true);
    setError(null);
    const current = new AbortController();
    controller.current?.abort();
    controller.current = current;
    try {
      const blob = await publicRunApi.artifact(token, artifact, current.signal);
      if (current.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      if (preview) setVideoUrl(url);
      else {
        const extension = artifact.category === "video" ? "webm" : artifact.category === "snapshots" ? "tar.gz"
          : artifact.category === "network" ? "har" : artifact.contentType === "application/x-ndjson" ? "jsonl" : "json";
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `${artifact.id}.${extension}`;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (cause) {
      if (!current.signal.aborted) setError(cause instanceof Error ? cause.message : "Download failed");
    } finally {
      if (!current.signal.aborted) setPending(false);
    }
  }

  return <div className="max-w-full space-y-2">
    <div className="flex gap-2">
      {artifact.category === "video" && <Button variant="outline" size="sm" disabled={pending} onClick={() => void load(true)}>Play video</Button>}
      <Button variant="outline" size="sm" disabled={pending} onClick={() => void load(false)}>{pending ? "Loading..." : "Download"}</Button>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {videoUrl && <video className="max-h-96 max-w-full rounded-md" src={videoUrl} controls autoPlay onError={() => setError("This recording is unavailable or uses an unsupported video format.")} />}
  </div>;
}

export function SharedRunPage() {
  const [token, setToken] = useState(() => tokenFromFragment(window.location.hash));
  useEffect(() => {
    const update = () => setToken(tokenFromFragment(window.location.hash));
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  const query = useQuery({
    queryKey: ["public-run", token],
    queryFn: ({ signal }) => publicRunApi.view(token!, signal),
    enabled: !!token, retry: false, gcTime: 0, staleTime: 0, refetchInterval: 15_000,
  });
  const unavailable = !token || (query.error instanceof SharedRunError && query.error.status === 404);
  return <div className="min-h-screen bg-background text-foreground">
    <header className="border-b"><div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
      <a href="/" className="font-semibold tracking-tight">Scope</a><span className="text-xs text-muted-foreground">Shared benchmark results</span>
    </div></header>
    <main className="mx-auto max-w-6xl px-6 py-8">
      {unavailable || query.error ? <SharedRunUnavailable temporary={!unavailable} onRetry={() => void query.refetch()} /> : !query.data ? <div role="status" aria-label="Loading shared run" className="space-y-4">
        <Skeleton className="h-12 w-72" /><Skeleton className="h-40 w-full" />
      </div> : <SharedRunView
        key={`${token}-${JSON.stringify(query.data.content)}`}
        data={query.data}
        logs={token && <SharedLogs token={token} />}
        reports={token && <SharedReports token={token} />}
        artifactActions={(artifact) => token && <ArtifactActions token={token} artifact={artifact} />}
      />}
    </main>
  </div>;
}
