// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface EmbeddedTableBlockProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function EmbeddedTableBlock({
  title,
  description,
  actions,
  children,
  className,
}: EmbeddedTableBlockProps) {
  return (
    <section
      className={cn("space-y-3", className)}
      data-slot="embedded-table-block"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          {description && (
            <p className="mt-1 text-xs text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {actions}
      </header>
      <div className="min-w-0">{children}</div>
    </section>
  );
}
