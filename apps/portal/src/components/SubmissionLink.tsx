// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Link } from "react-router-dom";
import { Link2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ShortId } from "@/components/ShortId";
import { submissionResultsPath } from "@/lib/submission-links";

interface SubmissionLinkProps {
  submissionId: string;
  projectId: string;
}

export function SubmissionLink({ submissionId, projectId }: SubmissionLinkProps) {
  const path = submissionResultsPath(submissionId, projectId);

  const copyLink = async () => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard access requires a secure browser context.");
      }
      await navigator.clipboard.writeText(new URL(path, window.location.origin).href);
      toast.success("Submission link copied");
    } catch (error) {
      toast.error("Could not copy submission link", {
        description: error instanceof Error ? error.message : "Clipboard access was denied.",
      });
    }
  };

  return (
    <span
      className="inline-flex items-center gap-1"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <Link to={path} aria-label={`View submission ${submissionId}`} className="hover:underline">
        <ShortId id={submissionId} label="submission ID" />
      </Link>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0"
        aria-label={`Copy link to submission ${submissionId}`}
        title="Copy submission link"
        onClick={copyLink}
      >
        <Link2 className="h-3.5 w-3.5" />
      </Button>
    </span>
  );
}
