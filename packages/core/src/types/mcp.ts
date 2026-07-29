// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// --- MCP Server types ---

/** Supported MCP transport types */
export type McpTransportType = "sse" | "http" | "stdio";

/** MCP server session mode */
export type McpSessionMode = "stateful" | "stateless";

/** MCP server HTTP header (name-value pair) */
export interface McpServerHeader {
  name: string;
  value: string;
}

/** MCP server document stored in MongoDB */
export interface McpServerDocument {
  _id: string;                    // Slug identifier (e.g. "my-search-server")
  name: string;                   // Human-readable display name
  type: McpTransportType;         // Transport type
  url?: string;                   // Server URL (required for sse/http)
  command?: string;               // Executable to spawn (required for stdio)
  args?: string[];                // CLI arguments for stdio command
  env?: Record<string, string>;   // Environment variables for stdio command
  headers?: McpServerHeader[];    // Auth headers, API keys, etc. (sse/http)
  sessionMode?: McpSessionMode;   // Gateway session mode (default: stateless for http, stateful for stdio)
  version?: string;               // Package version pin for stdio npm packages
  description?: string;
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date;               // Soft-delete timestamp
}

/** MCP server secret document stored in Token Manager MongoDB (values live in Key Vault only) */
export interface McpSecretDocument {
  _id: string;        // MongoDB ObjectId as hex string
  mcpId: string;      // McpServerDocument._id slug (e.g. "azure")
  name: string;       // Secret name (e.g. "AZURE_CLIENT_SECRET" or "Authorization")
  createdAt: Date;
  updatedAt: Date;
}

/** Resolved MCP server configuration passed to workers at runtime */
export interface McpServerConfig {
  type: McpTransportType;
  slug: string;                   // Gateway-safe identifier (^[a-zA-Z0-9_-]+$), maps from McpServerDocument._id; used for secret resolution
  name: string;                   // Human-readable display name
  url?: string;                   // required for sse/http
  command?: string;               // required for stdio
  args?: string[];
  env?: Record<string, string>;
  headers?: McpServerHeader[];
  sessionMode?: McpSessionMode;
  version?: string;
}
