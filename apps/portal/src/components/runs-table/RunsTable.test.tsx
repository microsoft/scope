// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RunOutcomeCell,
  RunStatusCell,
  type RunTableItem,
} from "./RunTableCells";
import { RunsTable } from "./RunsTable";
import type { DataTableColumn } from "@/components/list-layout";

const items: RunTableItem[] = [
  {
    requestId: "request-processing",
    runId: "run-processing",
    status: "processing",
    outcome: undefined,
  },
  {
    requestId: "request-deleted",
    runId: "run-deleted",
    status: "deleted",
    outcome: "failed",
  },
];

const columns: DataTableColumn<RunTableItem>[] = [
  {
    id: "status",
    header: "Status",
    cell: (item) => <RunStatusCell item={item} />,
  },
  {
    id: "outcome",
    header: "Outcome",
    cell: (item) => <RunOutcomeCell item={item} />,
  },
];

describe("RunsTable", () => {
  afterEach(cleanup);

  it("uses the canonical status and outcome widgets", () => {
    render(
      <RunsTable
        items={items}
        columns={columns}
        getRowId={(item) => item.requestId}
      />,
    );

    expect(screen.getAllByText("Processing")[0].className).toContain(
      "animate-shimmer",
    );
    expect(screen.getAllByText("Deleted").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Failed").length).toBeGreaterThan(0);
  });

  it("keeps row clicks isolated from selection controls", () => {
    const onRowClick = vi.fn();
    const onToggle = vi.fn();
    render(
      <RunsTable
        items={items}
        columns={columns}
        getRowId={(item) => item.requestId}
        onRowClick={onRowClick}
        selection={{
          selectedIds: new Set(),
          onToggle,
          onToggleAll: vi.fn(),
        }}
      />,
    );

    fireEvent.click(screen.getAllByRole("checkbox", { name: "Select row" })[0]);
    expect(onToggle).toHaveBeenCalledWith(
      "request-processing",
      items[0],
    );
    expect(onRowClick).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByText("Processing")[0]);
    expect(onRowClick).toHaveBeenCalledWith(items[0]);
  });

  it("renders controlled pagination through the shared shell", () => {
    const onPageChange = vi.fn();
    render(
      <RunsTable
        items={items}
        columns={columns}
        getRowId={(item) => item.requestId}
        pagination={{
          page: 1,
          pageSize: 1,
          total: 2,
          onPageChange,
          onPageSizeChange: vi.fn(),
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });
});
