// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Key, ReactNode } from "react";
import {
  DataTable,
  Pagination,
  type DataTableColumn,
  type DataTableGrouping,
  type DataTableSelection,
} from "@/components/list-layout";
import { TooltipProvider } from "@/components/ui/tooltip";

export interface RunsTablePagination {
  page: number;
  pageSize: number;
  total?: number;
  hasNext?: boolean;
  hasPrev?: boolean;
  itemLabel?: string;
  pageSizeOptions?: number[];
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}

export interface RunsTableProps<T> {
  items: T[];
  columns: readonly DataTableColumn<T>[];
  getRowId: (item: T) => string;
  activeId?: Key | null;
  onRowClick?: (item: T) => void;
  selection?: DataTableSelection<T>;
  grouping?: DataTableGrouping<T>;
  sort?: string | null;
  sortDir?: "asc" | "desc";
  onSortChange?: (column: string) => void;
  loading?: boolean;
  loadingRows?: number;
  emptyState?: ReactNode;
  density?: "compact" | "comfortable";
  pagination?: RunsTablePagination;
}

/** Shared run-list shell. Data fetching and page-specific composition stay outside. */
export function RunsTable<T>({
  pagination,
  ...tableProps
}: RunsTableProps<T>) {
  return (
    <TooltipProvider delayDuration={200}>
      <div className="space-y-2" data-slot="runs-table">
        <DataTable {...tableProps} />
        {pagination && (
          <Pagination
            page={pagination.page}
            pageSize={pagination.pageSize}
            total={pagination.total}
            hasNext={pagination.hasNext}
            hasPrev={pagination.hasPrev}
            itemLabel={pagination.itemLabel ?? "runs"}
            pageSizeOptions={pagination.pageSizeOptions}
            onPageChange={pagination.onPageChange}
            onPageSizeChange={pagination.onPageSizeChange}
          />
        )}
      </div>
    </TooltipProvider>
  );
}
