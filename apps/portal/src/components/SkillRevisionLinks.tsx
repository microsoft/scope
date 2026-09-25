// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Link } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { parseSkillSpec, shortCommitHash } from "@/lib/skill-spec";

export interface SkillRevisionLinksProps {
  references: readonly string[];
}

export function SkillRevisionLinks({ references }: SkillRevisionLinksProps) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {references.map((reference) => {
        const { slug, commitHash } = parseSkillSpec(reference);
        return (
          <Link key={reference} to={`/skills/${slug}`}>
            <Badge
              variant="secondary"
              className="gap-1 font-mono text-xs transition-colors hover:bg-accent"
            >
              {slug}
              {commitHash && (
                <span className="text-muted-foreground" title={commitHash}>
                  @{shortCommitHash(commitHash)}
                </span>
              )}
            </Badge>
          </Link>
        );
      })}
    </div>
  );
}
