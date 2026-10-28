// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { McpServerForm } from "@/components/McpServerForm";
import type { McpServerDocument } from "@/types";

interface McpServerCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (server: McpServerDocument) => void;
}

export function McpServerCreateDialog({ open, onOpenChange, onCreated }: McpServerCreateDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
        <DialogHeader>
          <DialogTitle>New MCP Server</DialogTitle>
          <DialogDescription>
            Register an MCP server without leaving this flow.
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-6 min-h-0 overflow-y-auto px-6">
          <McpServerForm
            className="pb-1"
            stickyFooter
            showCancel={false}
            onCreated={onCreated}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
