// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Bot, Scale, CheckCircle2, AlertCircle, Brain, Wrench, ChevronRight, ChevronDown, Loader2, Plug } from "lucide-react";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { GATE_METADATA } from "@/lib/gates";
import { resolveMcpToolName } from "@/lib/mcp-tool-name";
import type { ConversationTurn, ToolCall } from "@/types";
import { useHarExtraction, type ConversationSegment } from "@/hooks/useHarExtraction";

interface ConversationViewProps {
  turns: ConversationTurn[];
  /** The original task / user prompt, shown as the first message */
  task?: string;
  /** Run ID — needed to fetch HAR data for each turn */
  runId: string;
  /** If provided, uses per-run URL for a specific historical attempt */
  attemptRunId?: string;
  /** MCP server names configured on the run — used to label MCP tool calls */
  mcpServerNames?: string[];
}

/**
 * Chat-style conversation view showing agent responses and judge feedback.
 *
 * Layout:
 * - Task prompt (top, full-width, neutral)
 * - For each turn:
 *   - Thinking content (collapsible, muted)
 *   - Agent response (right-aligned, primary tint)
 *   - Tool calls (inline, collapsible)
 *   - Judge feedback (left-aligned, amber tint)
 */
export function ConversationView({ turns, task, runId, attemptRunId, mcpServerNames }: ConversationViewProps) {
  if (turns.length === 0 && !task) {
    return (
      <div className="text-sm text-muted-foreground italic py-4 text-center">
        No conversation data available.
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-4xl py-2">
      {/* Task prompt */}
      {task && (
        <div className="flex justify-center">
          <Card className="max-w-[85%] bg-muted/40 border-muted">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <Badge variant="secondary" className="text-xs gap-1">
                  Task
                </Badge>
              </div>
              <div className="prose prose-sm dark:prose-invert max-w-none">
                <MarkdownRenderer>{task}</MarkdownRenderer>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Turn messages */}
      {turns.map((turn) => (
        <TurnMessages
          key={turn.iteration}
          turn={turn}
          scopedIteration={turn.iteration}
          runId={runId}
          attemptRunId={attemptRunId}
          mcpServerNames={mcpServerNames}
        />
      ))}
    </div>
  );
}

/** Collapsible section with a toggle header */
function CollapsibleSection({
  label,
  icon: Icon,
  iconClassName,
  count,
  timestamp,
  preview,
  defaultOpen = false,
  children,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  iconClassName?: string;
  count?: number;
  timestamp?: string;
  /** One-line preview shown when collapsed */
  preview?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors w-full text-left py-1 min-w-0"
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
        <Icon className={cn("h-3 w-3 shrink-0", iconClassName)} />
        <span className="shrink-0">{label}</span>
        {count !== undefined && (
          <Badge variant="secondary" className="text-[10px] px-1 py-0 ml-1 shrink-0">{count}</Badge>
        )}
        {!open && preview && (
          <span className="text-muted-foreground/70 italic truncate ml-1 min-w-0">
            {preview}
          </span>
        )}
        {timestamp && (
          <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
            {new Date(timestamp).toLocaleTimeString()}
          </span>
        )}
      </button>
      {open && <div className="mt-1">{children}</div>}
    </div>
  );
}

/** Inline tool call display */
function ToolCallInline({ tc, mcpServerNames }: { tc: ToolCall; mcpServerNames?: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const hasResponse = !!tc.response;
  const argsStr = JSON.stringify(tc.arguments, null, 2);
  const argsOneLine = JSON.stringify(tc.arguments);
  const mcp = resolveMcpToolName(tc.name, mcpServerNames);

  return (
    <div className="rounded border border-border/50 bg-muted/30 text-xs font-mono">
      <button
        type="button"
        className="flex items-center gap-1.5 w-full text-left px-2 py-1.5 hover:bg-muted/50 transition-colors min-w-0"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
        {mcp.isMcp ? (
          <Plug className="h-3 w-3 text-violet-500 shrink-0" />
        ) : (
          <Wrench className="h-3 w-3 text-blue-500 shrink-0" />
        )}
        {mcp.isMcp && (
          <Badge
            variant="outline"
            className="text-[10px] px-1 py-0 shrink-0 border-violet-300 text-violet-600 dark:border-violet-700 dark:text-violet-400"
            title={`MCP server: ${mcp.server}`}
          >
            MCP
          </Badge>
        )}
        {mcp.isMcp && (
          <span className="text-muted-foreground shrink-0">{mcp.server}<span className="text-muted-foreground/50">/</span></span>
        )}
        <span className="font-semibold text-foreground shrink-0">{mcp.tool}</span>
        {!expanded && argsOneLine !== "{}" && (
          <span className="text-muted-foreground truncate ml-1 min-w-0">
            {argsOneLine}
          </span>
        )}
        <span className="flex items-center gap-1.5 ml-auto shrink-0">
          {!hasResponse && (
            <Badge variant="outline" className="text-[10px] px-1 py-0 text-amber-600 border-amber-300">
              no response
            </Badge>
          )}
          {tc.timestamp && (
            <span className="text-[10px] text-muted-foreground">
              {new Date(tc.timestamp).toLocaleTimeString()}
            </span>
          )}
        </span>
      </button>
      {expanded && (
        <div className="px-2 pb-2 space-y-1.5 border-t border-border/30">
          {argsStr !== "{}" && (
            <div className="mt-1.5">
              <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Arguments</span>
              <pre className="mt-0.5 p-1.5 rounded bg-muted/50 text-[11px] overflow-x-auto whitespace-pre-wrap break-all">{argsStr}</pre>
            </div>
          )}
          {hasResponse && (
            <div>
              <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Response</span>
              <pre className="mt-0.5 p-1.5 rounded bg-muted/50 text-[11px] overflow-x-auto whitespace-pre-wrap break-all max-h-48 overflow-y-auto">{tc.response}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TurnMessages({ turn, scopedIteration, runId, attemptRunId, mcpServerNames }: { turn: ConversationTurn; scopedIteration: number; runId: string; attemptRunId?: string; mcpServerNames?: string[] }) {
  const hasHar = !!turn.harUrl;
  const { data: harData, isLoading: harLoading } = useHarExtraction(runId, turn.iteration, hasHar, attemptRunId);

  const segments = harData?.segments ?? [];
  const hasContentSegment = segments.some((s) => s.type === "content");
  const gateLabel = turn.gate ? GATE_METADATA[turn.gate].label : undefined;

  return (
    <>
      {/* Iteration divider */}
      <div className="flex items-center gap-3 my-2">
        <div className="flex-1 h-px bg-border" />
        <span className="text-xs text-muted-foreground font-medium">
          {gateLabel ? `${gateLabel} · ` : ""}Iteration {scopedIteration}
          {turn.passed && (
            <CheckCircle2 className="inline h-3 w-3 ml-1 text-emerald-600" />
          )}
        </span>
        <div className="flex-1 h-px bg-border" />
      </div>

      {/* Loading indicator */}
      {harLoading && hasHar && (
        <div className="flex justify-end">
          <div className="max-w-[85%] flex items-center gap-1.5 text-xs text-muted-foreground py-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>Loading HAR data…</span>
          </div>
        </div>
      )}

      {/* Chronological segments from HAR */}
      {segments.map((segment, idx) => (
        <SegmentBlock key={`seg-${idx}`} segment={segment} turn={turn} mcpServerNames={mcpServerNames} />
      ))}

      {/* Fallback: show DB agent response if no content segments from HAR */}
      {!hasContentSegment && !harLoading && (
        <AgentResponseBlock content={turn.codingAgentResponse} turn={turn} />
      )}

      {/* Judge feedback — left aligned */}
      <div className="flex justify-start">
        <Card className="max-w-[85%] bg-amber-500/5 border-amber-200 dark:border-amber-800">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <Scale className="h-4 w-4 text-amber-600" />
              <span className="text-xs font-medium text-amber-600">Judge</span>
              {turn.passed ? (
                <Badge variant="success" className="text-xs gap-1 ml-auto">
                  <CheckCircle2 className="h-3 w-3" /> Passed
                </Badge>
              ) : (
                <Badge variant="warning" className="text-xs gap-1 ml-auto">
                  <AlertCircle className="h-3 w-3" /> Incomplete
                </Badge>
              )}
            </div>
            <div className="prose prose-sm dark:prose-invert max-w-none max-h-96 overflow-y-auto">
              <MarkdownRenderer>{turn.judgeFeedback}</MarkdownRenderer>
            </div>

            {/* Criteria results inline */}
            {turn.criteriaResults && turn.criteriaResults.length > 0 && (
              <div className="mt-2 pt-2 border-t border-amber-200 dark:border-amber-800 space-y-1">
                {turn.criteriaResults.map((cr) => (
                  <div key={cr.criterionId} className="flex items-center gap-1.5 text-xs">
                    {cr.passed ? (
                      <CheckCircle2 className="h-3 w-3 text-emerald-600 shrink-0" />
                    ) : (
                      <AlertCircle className="h-3 w-3 text-red-500 shrink-0" />
                    )}
                    <span className="font-mono">{cr.criterionId}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

/** Render a single chronological segment */
function SegmentBlock({ segment, turn, mcpServerNames }: { segment: ConversationSegment; turn: ConversationTurn; mcpServerNames?: string[] }) {
  switch (segment.type) {
    case "thinking":
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] w-full">
            <CollapsibleSection
              label="Thinking"
              icon={Brain}
              iconClassName="text-violet-500"
              preview={segment.content}
              timestamp={segment.timestamp}
            >
              <Card className="bg-violet-500/5 border-violet-200 dark:border-violet-800">
                <CardContent className="p-3">
                  <div className="prose prose-sm dark:prose-invert max-w-none max-h-64 overflow-y-auto text-muted-foreground italic text-xs">
                    <MarkdownRenderer>{segment.content}</MarkdownRenderer>
                  </div>
                </CardContent>
              </Card>
            </CollapsibleSection>
          </div>
        </div>
      );

    case "content":
      return <AgentResponseBlock content={segment.content} turn={turn} />;

    case "tool_calls":
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] w-full">
            <CollapsibleSection
              label="Tool Calls"
              icon={Wrench}
              iconClassName="text-blue-500"
              count={segment.toolCalls.length}
              timestamp={segment.toolCalls[0]?.timestamp}
              defaultOpen={segment.toolCalls.length <= 5}
            >
              <div className="space-y-1">
                {segment.toolCalls.map((tc, idx) => (
                  <ToolCallInline key={tc.id || idx} tc={tc} mcpServerNames={mcpServerNames} />
                ))}
              </div>
            </CollapsibleSection>
          </div>
        </div>
      );
  }
}

/** Agent response card — right aligned */
function AgentResponseBlock({ content, turn }: { content: string | undefined; turn: ConversationTurn }) {
  const hasContent = typeof content === "string" && content.length > 0;
  return (
    <div className="flex justify-end">
      <Card className={cn(
        "max-w-[85%] border",
        turn.passed
          ? "bg-emerald-500/5 border-emerald-200 dark:border-emerald-800"
          : "bg-primary/5 border-primary/20",
      )}>
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-2">
            <Bot className="h-4 w-4 text-primary" />
            <span className="text-xs font-medium text-primary">Coding Agent</span>
            <span className="text-xs text-muted-foreground ml-auto">
              {new Date(turn.timestamp).toLocaleTimeString()}
            </span>
          </div>
          {hasContent ? (
            <div className="prose prose-sm dark:prose-invert max-w-none max-h-96 overflow-y-auto">
              <MarkdownRenderer>{content}</MarkdownRenderer>
            </div>
          ) : (
            <p className="text-xs italic text-muted-foreground">
              No assistant response captured — see raw chat / HAR for the full transcript.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
