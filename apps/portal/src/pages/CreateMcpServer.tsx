// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { McpServerForm } from "@/components/McpServerForm";

export function CreateMcpServer() {
  const navigate = useNavigate();

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={() => navigate("/mcp-servers")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Add MCP Server</h1>
          <p className="text-muted-foreground">Register a remote MCP server for use in benchmark runs</p>
        </div>
      </div>

      <McpServerForm
        showCancel={false}
        onCreated={(server) => navigate(`/mcp-servers/${server._id}`)}
      />
    </div>
  );
}
