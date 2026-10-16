// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Layers3 } from "lucide-react";
import { Link } from "react-router-dom";
import { ShortId } from "@/components/ShortId";
import { cn } from "@/lib/utils";

export function SubmissionLink({
  submissionId,
  className,
  compact = false,
}: {
  submissionId: string;
  className?: string;
  compact?: boolean;
}) {
  return (
    <Link
      to={`/submissions/${submissionId}`}
      aria-label={`Open submission ${submissionId}`}
      className={cn(
        "inline-flex items-center gap-1.5 font-medium text-primary hover:underline",
        className,
      )}
      onClick={(event) => event.stopPropagation()}
    >
      <Layers3 className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {!compact && <span>Submission</span>}
      <ShortId id={submissionId} label="submission ID" />
    </Link>
  );
}
