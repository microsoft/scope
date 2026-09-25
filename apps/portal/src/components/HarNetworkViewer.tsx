// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState, useMemo } from "react";
import { useHarData } from "@/hooks/useHarExtraction";
import { api } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { Download, Search, X, ChevronDown, ChevronRight, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { detectTransport, isAiCompletionEntry, type Transport } from "@/lib/har-extraction";

// ---------------------------------------------------------------------------
// Types (inline HAR 1.2 subset — no shared dep needed for the portal)
// ---------------------------------------------------------------------------
interface HarNameValue { name: string; value: string }
interface HarRequest {
  method: string;
  url: string;
  headers: HarNameValue[];
  postData?: { mimeType: string; text?: string };
}
interface HarResponse {
  status: number;
  statusText: string;
  headers: HarNameValue[];
  content: { size: number; mimeType: string; text?: string; encoding?: string };
}
interface HarEntry {
  startedDateTime: string;
  time: number;
  request: HarRequest;
  response: HarResponse;
  /** Chrome extension: resource type hint (e.g. "websocket"). */
  _resourceType?: string;
  /** Chrome extension: WebSocket messages recorded during the connection. */
  _webSocketMessages?: unknown[];
}
interface HarFile {
  log: { entries: HarEntry[] };
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
interface HarNetworkViewerProps {
  runId: string;
  /** If provided, fetches HAR for a specific iteration */
  iteration?: number;
  /** If provided, uses per-run URL for a specific historical attempt */
  attemptRunId?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function formatStarted(iso: string): string {
  try {
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    const ms = String(d.getMilliseconds()).padStart(3, "0");
    return `${hh}:${mm}:${ss}.${ms}`;
  } catch {
    return iso;
  }
}

function methodColor(method: string): string {
  switch (method.toUpperCase()) {
    case "GET": return "text-emerald-600 bg-emerald-500/10";
    case "POST": return "text-blue-600 bg-blue-500/10";
    case "PUT": return "text-amber-600 bg-amber-500/10";
    case "PATCH": return "text-orange-600 bg-orange-500/10";
    case "DELETE": return "text-red-600 bg-red-500/10";
    default: return "text-muted-foreground bg-muted";
  }
}

function statusColor(status: number): string {
  if (status < 300) return "text-emerald-600";
  if (status < 400) return "text-amber-600";
  return "text-red-600";
}

/** Extract a short path from a full URL for display. */
function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

/** Extract the host from a URL. */
function hostFromUrl(url: string): string {
  try { return new URL(url).host; } catch { return ""; }
}

/** Get content type category for the "Type" column. */
function contentCategory(entry: HarEntry): string {
  const ct = entry.response.content.mimeType || "";
  if (ct.includes("json")) return "json";
  if (ct.includes("html")) return "html";
  if (ct.includes("xml")) return "xml";
  if (ct.includes("javascript") || ct.includes("ecmascript")) return "js";
  if (ct.includes("css")) return "css";
  if (ct.includes("image")) return "img";
  if (ct.includes("font")) return "font";
  if (ct.includes("text/event-stream")) return "sse";
  if (ct.includes("text")) return "text";
  return ct.split("/").pop()?.split(";")[0] ?? "other";
}

/** Label + Tailwind classes for a transport badge. HTTP is intentionally quiet. */
function transportBadge(t: Transport): { label: string; className: string } {
  switch (t) {
    case "sse":
      return { label: "SSE", className: "text-amber-600 bg-amber-500/10" };
    case "websocket":
      return { label: "WS", className: "text-cyan-600 bg-cyan-500/10" };
    default:
      return { label: "HTTP", className: "text-muted-foreground bg-muted" };
  }
}

/**
 * Re-encode a string from Latin-1 code points back to UTF-8.
 * Fixes "mojibake" where UTF-8 bytes were stored as Latin-1 characters.
 */
function repairMojibake(text: string): string {
  if (!/\xc2[\x80-\xbf]|\xc3[\x80-\xbf]|\xe2[\x80-\xbf]/.test(text)) return text;
  try {
    const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return text;
  }
}

/** Decode response body text (handle base64 and mojibake). */
function decodeBody(content: HarResponse["content"]): string | null {
  if (!content.text) return null;
  if (content.encoding === "base64") {
    try {
      const binary = atob(content.text);
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      return new TextDecoder("utf-8").decode(bytes);
    } catch { return null; }
  }
  return repairMojibake(content.text);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export function HarNetworkViewer({ runId, iteration, attemptRunId }: HarNetworkViewerProps) {
  const [filter, setFilter] = useState("");
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);

  const { data: har, isLoading, error } = useHarData<HarFile>(runId, iteration, true, attemptRunId);

  const entries = useMemo(() => {
    if (!har) return [];
    const all = har.log.entries;
    if (!filter) return all;
    const lf = filter.toLowerCase();
    return all.filter((e) => {
      const transport = detectTransport(e);
      const matchesClassification =
        transport.includes(lf) ||
        (lf === "ws" && transport === "websocket") ||
        (lf === "ai" && isAiCompletionEntry(e));
      return (
        e.request.url.toLowerCase().includes(lf) ||
        e.request.method.toLowerCase().includes(lf) ||
        String(e.response.status).includes(lf) ||
        matchesClassification
      );
    });
  }, [har, filter]);

  // Summary stats
  const totalTime = useMemo(
    () => entries.reduce((sum, e) => sum + (e.time || 0), 0),
    [entries],
  );
  const totalSize = useMemo(
    () => entries.reduce((sum, e) => sum + (e.response.content.size || 0), 0),
    [entries],
  );
  const stats = useMemo(() => {
    let ai = 0, sse = 0, ws = 0;
    for (const e of entries) {
      if (isAiCompletionEntry(e)) ai++;
      const t = detectTransport(e);
      if (t === "sse") sse++;
      else if (t === "websocket") ws++;
    }
    return { ai, sse, ws };
  }, [entries]);

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        Failed to load HAR data: {error instanceof Error ? error.message : String(error)}
      </div>
    );
  }

  if (!har || entries.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        No network requests captured.
      </div>
    );
  }

  const selected = selectedIdx !== null ? entries[selectedIdx] : null;

  return (
    <div className="space-y-3">
      {/* Summary bar */}
      <div className="flex items-center gap-4 text-sm">
        <span className="font-medium">{entries.length} requests</span>
        <span className="text-muted-foreground">{formatBytes(totalSize)} transferred</span>
        <span className="text-muted-foreground">{formatMs(totalTime)} total</span>
        {stats.ai > 0 && (
          <span className="inline-flex items-center gap-1 font-medium text-violet-600">
            <Sparkles className="h-3 w-3" />
            {stats.ai} AI
          </span>
        )}
        {stats.sse > 0 && <span className="font-medium text-amber-600">{stats.sse} SSE</span>}
        {stats.ws > 0 && <span className="font-medium text-cyan-600">{stats.ws} WS</span>}
        <div className="flex-1" />
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => window.open(attemptRunId ? api.runHarUrl(runId, attemptRunId, iteration) : api.harUrl(runId, iteration), "_blank")}
        >
          <Download className="h-3 w-3" />
          Download HAR
        </Button>
      </div>

      {/* Filter bar */}
      <div className="relative">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by URL, method, or status…"
          className="w-full rounded-md border border-input bg-background px-9 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        {filter && (
          <button
            onClick={() => setFilter("")}
            className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Request table + detail panel */}
      <Card>
        <CardContent className="p-0">
          <div className={cn("flex", selected && "divide-x")}>
            {/* Request list (left side) */}
            <div className={cn("overflow-x-auto", selected ? "w-1/2" : "w-full")}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50 text-left">
                    <th className="p-2 pl-3 font-medium w-[60px]">Method</th>
                    <th className="p-2 font-medium w-[100px]">Started</th>
                    <th className="p-2 font-medium w-[56px]">AI</th>
                    <th className="p-2 font-medium">URL</th>
                    <th className="p-2 font-medium w-[60px]">Status</th>
                    <th className="p-2 font-medium w-[80px]">Transport</th>
                    <th className="p-2 font-medium w-[70px]">Type</th>
                    <th className="p-2 font-medium w-[70px] text-right">Size</th>
                    <th className="p-2 pr-3 font-medium w-[70px] text-right">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry, idx) => {
                    const transport = detectTransport(entry);
                    const tBadge = transportBadge(transport);
                    const isAi = isAiCompletionEntry(entry);
                    return (
                    <tr
                      key={idx}
                      onClick={() => setSelectedIdx(selectedIdx === idx ? null : idx)}
                      className={cn(
                        "border-b last:border-0 cursor-pointer hover:bg-muted/30 transition-colors",
                        selectedIdx === idx ? "bg-primary/5" : isAi && "bg-violet-500/[0.04]",
                      )}
                    >
                      <td className="p-2 pl-3">
                        <span className={cn("font-mono text-xs font-semibold px-1.5 py-0.5 rounded", methodColor(entry.request.method))}>
                          {entry.request.method}
                        </span>
                      </td>
                      <td className="p-2 text-xs text-muted-foreground tabular-nums" title={`UTC: ${new Date(entry.startedDateTime).toISOString()}\nLocal: ${new Date(entry.startedDateTime).toString()}`}>
                        {formatStarted(entry.startedDateTime)}
                      </td>
                      <td className="p-2">
                        {isAi && (
                          <span className="inline-flex items-center gap-0.5 shrink-0 font-semibold text-[10px] px-1.5 py-0.5 rounded text-violet-600 bg-violet-500/10" title="AI completion call">
                            <Sparkles className="h-2.5 w-2.5" />
                            AI
                          </span>
                        )}
                      </td>
                      <td className="p-2 max-w-[400px]">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="font-mono text-xs truncate" title={entry.request.url}>
                            {shortUrl(entry.request.url)}
                          </span>
                        </div>
                      </td>
                      <td className={cn("p-2 font-mono text-xs font-medium", statusColor(entry.response.status))}>
                        {entry.response.status}
                      </td>
                      <td className="p-2">
                        <span className={cn("font-mono text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase", tBadge.className)}>
                          {tBadge.label}
                        </span>
                      </td>
                      <td className="p-2 text-xs text-muted-foreground">
                        {transport === "http" ? (contentCategory(entry) || "—") : "—"}
                      </td>
                      <td className="p-2 text-xs text-muted-foreground text-right tabular-nums">
                        {formatBytes(entry.response.content.size)}
                      </td>
                      <td className="p-2 pr-3 text-xs text-muted-foreground text-right tabular-nums">
                        {formatMs(entry.time)}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Detail panel (right side) */}
            {selected && (
              <DetailPanel entry={selected} onClose={() => setSelectedIdx(null)} />
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail Panel
// ---------------------------------------------------------------------------

function DetailPanel({ entry, onClose }: { entry: HarEntry; onClose: () => void }) {
  const [tab, setTab] = useState<"headers" | "request" | "response">("headers");

  const requestBody = entry.request.postData?.text ?? null;
  const responseBody = decodeBody(entry.response.content);
  const transport = detectTransport(entry);
  const tBadge = transportBadge(transport);
  const isAi = isAiCompletionEntry(entry);

  return (
    <div className="w-1/2 flex flex-col max-h-[600px]">
      {/* Panel header */}
      <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/30">
        <div className="flex items-center gap-2">
          <span className={cn("font-mono text-xs font-semibold px-1.5 py-0.5 rounded", methodColor(entry.request.method))}>
            {entry.request.method}
          </span>
          <span className={cn("font-mono text-xs font-medium", statusColor(entry.response.status))}>
            {entry.response.status} {entry.response.statusText}
          </span>
          <span className={cn("font-mono text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase", tBadge.className)}>
            {tBadge.label}
          </span>
          {isAi && (
            <span className="inline-flex items-center gap-0.5 font-semibold text-[10px] px-1.5 py-0.5 rounded text-violet-600 bg-violet-500/10" title="AI completion call">
              <Sparkles className="h-2.5 w-2.5" />
              AI
            </span>
          )}
        </div>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* URL */}
      <div className="px-3 py-1.5 border-b text-xs font-mono text-muted-foreground truncate" title={entry.request.url}>
        {hostFromUrl(entry.request.url)}{shortUrl(entry.request.url)}
      </div>

      {/* Sub-tabs */}
      <div className="flex border-b text-xs">
        {(["headers", "request", "response"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "px-3 py-1.5 capitalize transition-colors",
              tab === t
                ? "border-b-2 border-primary text-foreground font-medium"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t === "request" ? "Request Body" : t === "response" ? "Response Body" : "Headers"}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-3 text-xs">
        {tab === "headers" && <HeadersTab entry={entry} />}
        {tab === "request" && <BodyTab body={requestBody} mimeType={entry.request.postData?.mimeType} />}
        {tab === "response" && <BodyTab body={responseBody} mimeType={entry.response.content.mimeType} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Headers sub-tab
// ---------------------------------------------------------------------------

function HeadersTab({ entry }: { entry: HarEntry }) {
  return (
    <div className="space-y-4">
      <HeaderSection title="Request Headers" headers={entry.request.headers} />
      <HeaderSection title="Response Headers" headers={entry.response.headers} />
      <div>
        <h5 className="font-medium text-muted-foreground mb-1">General</h5>
        <div className="space-y-0.5">
          <HeaderRow name="Request URL" value={entry.request.url} />
          <HeaderRow name="Request Method" value={entry.request.method} />
          <HeaderRow name="Status Code" value={`${entry.response.status} ${entry.response.statusText}`} />
          <HeaderRow name="Time" value={formatMs(entry.time)} />
          <HeaderRow name="Started" value={entry.startedDateTime} />
        </div>
      </div>
    </div>
  );
}

function HeaderSection({ title, headers }: { title: string; headers: HarNameValue[] }) {
  const [collapsed, setCollapsed] = useState(false);

  if (headers.length === 0) return null;

  return (
    <div>
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex items-center gap-1 font-medium text-muted-foreground mb-1 hover:text-foreground transition-colors"
      >
        {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        {title} ({headers.length})
      </button>
      {!collapsed && (
        <div className="space-y-0.5 ml-4">
          {headers.map((h, i) => (
            <HeaderRow key={`${h.name}-${i}`} name={h.name} value={h.value} />
          ))}
        </div>
      )}
    </div>
  );
}

function HeaderRow({ name, value }: { name: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="font-medium text-foreground shrink-0">{name}:</span>
      <span className="text-muted-foreground break-all">{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Body sub-tab
// ---------------------------------------------------------------------------

function BodyTab({ body, mimeType }: { body: string | null; mimeType?: string }) {
  if (!body) {
    return <div className="text-muted-foreground italic">No body</div>;
  }

  // Try to pretty-print JSON
  if (mimeType?.includes("json") || mimeType?.includes("text/event-stream")) {
    // Handle SSE: try to pretty-print each data line
    if (body.includes("data: ")) {
      return (
        <pre className="whitespace-pre-wrap break-all font-mono bg-muted/30 rounded p-2 max-h-[400px] overflow-y-auto">
          {body.split("\n").map((line) => {
            if (line.startsWith("data: ") && line !== "data: [DONE]") {
              try {
                const parsed = JSON.parse(line.slice(6));
                return `data: ${JSON.stringify(parsed, null, 2)}`;
              } catch {
                return line;
              }
            }
            return line;
          }).join("\n")}
        </pre>
      );
    }

    try {
      const parsed = JSON.parse(body);
      return (
        <pre className="whitespace-pre-wrap break-all font-mono bg-muted/30 rounded p-2 max-h-[400px] overflow-y-auto">
          {JSON.stringify(parsed, null, 2)}
        </pre>
      );
    } catch {
      // fall through to raw display
    }
  }

  return (
    <pre className="whitespace-pre-wrap break-all font-mono bg-muted/30 rounded p-2 max-h-[400px] overflow-y-auto">
      {body}
    </pre>
  );
}
