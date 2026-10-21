// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, Download, ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";

interface TaxonomyDimension {
  name: string;
  score: number;
  maxScore: number;
  justification: string;
}

interface BehaviorPattern {
  id: string;
  category: string;
  observation: string;
  evidence: string[];
  impact: "positive" | "negative" | "neutral";
}

interface ActionItem {
  id: string;
  priority: "high" | "medium" | "low";
  title: string;
  description: string;
  category: string;
}

interface TaxonomyData {
  meta?: {
    schemaVersion?: string;
    generatedAt?: string;
    requestId?: string;
    runId?: string;
    model?: string;
  };
  scorecard?: {
    overall?: number;
    dimensions?: TaxonomyDimension[];
  };
  behaviorAnalysis?: {
    patterns?: BehaviorPattern[];
  };
  actionList?: {
    items?: ActionItem[];
  };
}

function ScoreBar({ score, maxScore }: { score: number; maxScore: number }) {
  const pct = Math.round((score / maxScore) * 100);
  const color = pct >= 80 ? "bg-green-500" : pct >= 50 ? "bg-yellow-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-mono text-muted-foreground w-12 text-right">{score}/{maxScore}</span>
    </div>
  );
}

function ImpactBadge({ impact }: { impact: string }) {
  const variant = impact === "positive" ? "default" : impact === "negative" ? "destructive" : "secondary";
  return <Badge variant={variant} className="text-xs">{impact}</Badge>;
}

function PriorityBadge({ priority }: { priority: string }) {
  const colors: Record<string, string> = {
    high: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
    medium: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
    low: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  };
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${colors[priority] ?? ""}`}>{priority}</span>;
}

function CollapsibleSection({ title, defaultOpen = true, children }: { title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button className="flex items-center gap-1 text-sm font-medium text-foreground hover:text-primary transition-colors" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        {title}
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}

export function TaxonomyTab({ runId, attemptRunId }: { runId: string; attemptRunId?: string }) {
  const url = attemptRunId ? api.runTaxonomyUrl(runId, attemptRunId) : api.taxonomyUrl(runId);

  const { data: taxonomy, isLoading, error } = useQuery<TaxonomyData>({
    queryKey: ["run-taxonomy", runId, attemptRunId],
    queryFn: async () => {
      const res = await fetch(url);
      if (!res.ok) {
        if (res.status === 404) return null;
        throw new Error(`Failed to fetch taxonomy: ${res.statusText}`);
      }
      return res.json();
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>Loading taxonomy…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <p>Failed to load taxonomy: {(error as Error).message}</p>
      </div>
    );
  }

  if (!taxonomy) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <p>Taxonomy not yet generated for this run.</p>
        <p className="text-xs mt-1">It will appear here once post-processing completes.</p>
      </div>
    );
  }

  const { meta, scorecard, behaviorAnalysis, actionList } = taxonomy;

  return (
    <div className="space-y-6">
      {/* Header with download */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-medium">Run Taxonomy</h3>
          {meta?.generatedAt && (
            <p className="text-xs text-muted-foreground mt-0.5">
              Generated {new Date(meta.generatedAt).toLocaleString()}
              {meta.model && <> · Model: <code className="text-xs">{meta.model}</code></>}
            </p>
          )}
        </div>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => window.open(url, "_blank")}>
          <Download className="h-4 w-4" />
          Download JSON
        </Button>
      </div>

      {/* Scorecard */}
      {scorecard && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              Scorecard
              {scorecard.overall !== undefined && (
                <Badge variant="outline" className="font-mono">{scorecard.overall}%</Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {scorecard.dimensions?.map((dim) => (
              <div key={dim.name} className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{dim.name}</span>
                </div>
                <ScoreBar score={dim.score} maxScore={dim.maxScore} />
                <p className="text-xs text-muted-foreground">{dim.justification}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Behavior Analysis */}
      {behaviorAnalysis?.patterns && behaviorAnalysis.patterns.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              Behavior Analysis ({behaviorAnalysis.patterns.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <CollapsibleSection title="Patterns" defaultOpen={behaviorAnalysis.patterns.length <= 5}>
              <div className="space-y-3">
                {behaviorAnalysis.patterns.map((pattern) => (
                  <div key={pattern.id} className="border rounded-md p-3 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="text-xs">{pattern.category}</Badge>
                      <ImpactBadge impact={pattern.impact} />
                    </div>
                    <p className="text-sm">{pattern.observation}</p>
                    {pattern.evidence.length > 0 && (
                      <ul className="text-xs text-muted-foreground list-disc list-inside space-y-0.5">
                        {pattern.evidence.map((e, i) => <li key={i}>{e}</li>)}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            </CollapsibleSection>
          </CardContent>
        </Card>
      )}

      {/* Action List */}
      {actionList?.items && actionList.items.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              Action Items ({actionList.items.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <CollapsibleSection title="Items" defaultOpen={actionList.items.length <= 8}>
              <div className="space-y-2">
                {actionList.items.map((item) => (
                  <div key={item.id} className="flex items-start gap-3 border rounded-md p-3">
                    <PriorityBadge priority={item.priority} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{item.title}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{item.description}</p>
                      <Badge variant="outline" className="text-xs mt-1">{item.category}</Badge>
                    </div>
                  </div>
                ))}
              </div>
            </CollapsibleSection>
          </CardContent>
        </Card>
      )}

      {/* Raw JSON fallback — collapsed by default */}
      <CollapsibleSection title="Raw JSON" defaultOpen={false}>
        <pre className="text-xs bg-muted/50 p-4 rounded-md overflow-x-auto max-h-96 overflow-y-auto">
          {JSON.stringify(taxonomy, null, 2)}
        </pre>
      </CollapsibleSection>
    </div>
  );
}
