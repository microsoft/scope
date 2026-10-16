// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Link } from "react-router-dom";
import { Plus } from "lucide-react";
import type { ReportEligibilityResponse } from "@/types";
import { Button } from "@/components/ui/button";

interface Props {
  eligibility?: ReportEligibilityResponse;
  loading: boolean;
  error: boolean;
  pending: boolean;
  onGenerate: () => void;
  onRetry: () => void;
}

export function ReportGenerationControls({ eligibility, loading, error, pending, onGenerate, onRetry }: Props) {
  const canGenerate = !loading && !error && !!eligibility?.templates.length;
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border p-4">
      <div className="space-y-2 text-sm text-muted-foreground" aria-live="polite">
        {loading ? (
          <p>Checking applicable report templates...</p>
        ) : error ? (
          <div role="alert">
            <p>Unable to check report templates. Report generation is unavailable until this check succeeds.</p>
            <Button variant="link" className="h-auto p-0" onClick={onRetry}>Retry template check</Button>
          </div>
        ) : eligibility?.activeTemplateCount === 0 ? (
          <p>
            Template-based report generation requires a report template in this run&apos;s project.
            {" "}No active report templates are configured.{" "}
            <Link to="/reports/templates" className="text-primary underline">Configure report templates</Link>.
          </p>
        ) : eligibility?.templates.length === 0 ? (
          <p>
            No active report template triggers match this run&apos;s criteria, task prompt, or detected prompt features.{" "}
            <Link to="/reports/templates" className="text-primary underline">Review report template triggers</Link>.
          </p>
        ) : (
          <>
            <p>Generate Report will queue one report for each matching template:</p>
            <ul className="list-disc pl-5">
              {eligibility?.templates.map((template) => (
                <li key={template.id}>{template.name} <span className="font-mono">({template.id})</span></li>
              ))}
            </ul>
          </>
        )}
      </div>
      <Button size="sm" onClick={onGenerate} disabled={!canGenerate || pending} className="shrink-0 gap-1.5">
        <Plus className="h-4 w-4" />
        Generate Report
      </Button>
    </div>
  );
}
