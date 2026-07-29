// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { McpServerHeaderSchema, McpServerResponseSchema, McpTransportTypeSchema, UpdateMcpServerInputSchema } from "@scope/core";
import { apiRoute } from "../openapi/api-route.js";
import type { McpServerDocument, RouteContext } from "../route-context.js";

export function registerMcpServersRoutes(ctx: RouteContext): void {

const { mcpSecretClient } = ctx;

const CreateMcpServerBodySchema = z.object({
  _id: z
    .string()
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/),
  name: z.string(),
  type: McpTransportTypeSchema,
  url: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  headers: z.array(McpServerHeaderSchema).optional(),
  sessionMode: z.enum(["stateful", "stateless"]).optional(),
  version: z.string().optional(),
  description: z.string().optional(),
});

// GET /api/v1/mcp/servers — list MCP servers (env/headers never shown in list)
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/mcp/servers",
  tags: ["MCP Servers"],
  summary: "List MCP servers",
  response: z.array(McpServerResponseSchema),
  handler: async (_req, res) => {
    const servers = await ctx.mcpServerCollection
      .find({ deletedAt: { $exists: false } })
      .toArray();
    servers.sort((a, b) => a._id.localeCompare(b._id));
    res.json(servers.map((s) => ({ ...s, id: s._id })));
  },
});

// GET /api/v1/mcp/servers/:id — get MCP server by slug
// When Token Manager is available, returns masked values for env/headers ("<secret>")
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/mcp/servers/:id",
  tags: ["MCP Servers"],
  summary: "Get MCP server",
  params: z.object({ id: z.string() }),
  response: McpServerResponseSchema,
  handler: async (req, res) => {
    const server = await ctx.mcpServerCollection.findOne({
      _id: req.params.id,
      deletedAt: { $exists: false },
    });
    if (!server) {
      res.status(404).json({ error: "MCP server not found" });
      return;
    }

    if (mcpSecretClient) {
      const items = await mcpSecretClient.listSecrets(server._id);
      if (items.length > 0) {
        const masked = Object.fromEntries(items.map((item) => [item.name, "<secret>"]));
        // Return masked env or headers depending on transport type
        if (server.type === "stdio") {
          res.json({ ...server, id: server._id, env: masked });
        } else {
          const maskedHeaders = items.map((item) => ({ name: item.name, value: "<secret>" }));
          res.json({ ...server, id: server._id, headers: maskedHeaders });
        }
        return;
      }
    }

    res.json({ ...server, id: server._id });
  },
});

// POST /api/v1/mcp/servers — create MCP server (upserts if soft-deleted)
// env/headers are rejected with 503 if Token Manager is not available
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/mcp/servers",
  tags: ["MCP Servers"],
  summary: "Create MCP server",
  body: CreateMcpServerBodySchema,
  response: McpServerResponseSchema,
  handler: async (req, res) => {
    const { _id, name, type, url, command, args, env, headers, sessionMode, version, description } = req.body;

    const hasSecrets = (env && Object.keys(env).length > 0) || (headers && headers.length > 0);
    if (hasSecrets && !mcpSecretClient) {
      res.status(503).json({ error: "Secret storage unavailable: TOKEN_MANAGER_URL is not configured" });
      return;
    }

    const now = new Date();
    const existing = await ctx.mcpServerCollection.findOne({ _id });

    if (existing) {
      // Upsert: un-delete if soft-deleted, update non-secret fields
      await ctx.mcpServerCollection.updateOne(
        { _id },
        {
          $set: {
            name,
            type,
            ...(url !== undefined ? { url } : {}),
            ...(command !== undefined ? { command } : {}),
            ...(args !== undefined ? { args } : {}),
            ...(sessionMode !== undefined ? { sessionMode } : {}),
            ...(version !== undefined ? { version } : {}),
            ...(description !== undefined ? { description } : {}),
            updatedAt: now,
          },
          $unset: {
            deletedAt: "",
            ...(mcpSecretClient ? { env: "", headers: "" } : {}),
          },
        },
      );
    } else {
      const serverDoc: McpServerDocument = {
        _id,
        name,
        type,
        ...(url ? { url } : {}),
        ...(command ? { command } : {}),
        ...(args ? { args } : {}),
        ...(sessionMode ? { sessionMode } : {}),
        ...(version ? { version } : {}),
        ...(description ? { description } : {}),
        createdAt: now,
      };
      await ctx.mcpServerCollection.insertOne(serverDoc);
    }

    // Store secrets in Token Manager — replace all existing secrets for this server
    if (mcpSecretClient && hasSecrets) {
      await mcpSecretClient.deleteAllSecrets(_id);
      if (env && Object.keys(env).length > 0) {
        await mcpSecretClient.storeEnv(_id, env);
      } else if (headers && headers.length > 0) {
        await mcpSecretClient.storeHeaders(_id, headers);
      }
    }

    const updated = await ctx.mcpServerCollection.findOne({ _id });
    res.status(existing ? 200 : 201).json({ ...updated, id: updated!._id });
  },
});

// PUT /api/v1/mcp/servers/:id — update MCP server
apiRoute(ctx.app, ctx.registry, {
  method: "put",
  path: "/api/v1/mcp/servers/:id",
  tags: ["MCP Servers"],
  summary: "Update MCP server",
  params: z.object({ id: z.string() }),
  body: UpdateMcpServerInputSchema,
  response: McpServerResponseSchema,
  handler: async (req, res) => {
    const { id } = req.params;
    const { name, type, url, command, args, env, headers, sessionMode, version, description } = req.body;

    const existing = await ctx.mcpServerCollection.findOne({
      _id: id,
      deletedAt: { $exists: false },
    });
    if (!existing) {
      res.status(404).json({ error: "MCP server not found" });
      return;
    }

    const hasSecrets = (env && Object.keys(env).length > 0) || (headers && headers.length > 0);
    if (hasSecrets && !mcpSecretClient) {
      res.status(503).json({ error: "Secret storage unavailable: TOKEN_MANAGER_URL is not configured" });
      return;
    }

    const wantsSecretReconciliation = env !== undefined || headers !== undefined;

    // Detect a transport-kind change across the stdio boundary.
    // GET interprets all Token Manager secrets as env (stdio) or headers (http/sse),
    // so keeping them when the type changes would return them as the wrong kind.
    const existingIsStdio = existing.type === "stdio";
    const newIsStdio = type !== undefined ? type === "stdio" : existingIsStdio;
    const typeChangesKind = type !== undefined && existingIsStdio !== newIsStdio;

    const updateFields: Record<string, unknown> = { updatedAt: new Date() };
    if (name !== undefined) updateFields.name = name;
    if (type !== undefined) updateFields.type = type;
    if (url !== undefined) updateFields.url = url;
    if (command !== undefined) updateFields.command = command;
    if (args !== undefined) updateFields.args = args;
    if (sessionMode !== undefined) updateFields.sessionMode = sessionMode;
    if (version !== undefined) updateFields.version = version;
    if (description !== undefined) updateFields.description = description;

    const mongoUpdate: Record<string, unknown> = { $set: updateFields };
    if (mcpSecretClient && wantsSecretReconciliation) {
      (mongoUpdate as any).$unset = { env: "", headers: "" };
    }

    await ctx.mcpServerCollection.updateOne({ _id: id }, mongoUpdate);

    // When the transport kind changes (stdio ↔ non-stdio) and no explicit secret
    // reconciliation was requested, delete all existing secrets — GET would otherwise
    // re-interpret them as the wrong type (env ↔ headers).
    if (mcpSecretClient && typeChangesKind && !wantsSecretReconciliation) {
      const itemsToDelete = await mcpSecretClient.listSecrets(id);
      await Promise.all(itemsToDelete.map((item) => mcpSecretClient!.deleteSecret(id, item.name)));
    }

    // Reconcile secrets in Token Manager when secret fields are provided.
    // - Empty/`"<secret>"` values preserve the existing secret for that key.
    // - Keys omitted from the payload are deleted.
    // - An empty env object (`{}`) or empty headers array (`[]`) deletes all existing secrets.
    // Only one of env/headers may be present (enforced above).
    if (mcpSecretClient && wantsSecretReconciliation) {
      const existingItems = await mcpSecretClient.listSecrets(id);
      const existingNames = new Set(existingItems.map((item) => item.name));

      if (env !== undefined) {
        const submittedEntries = Object.entries(env);
        const submittedNames = new Set(submittedEntries.map(([name]) => name));

        // Delete secrets that the client explicitly removed (including all when env is {}).
        for (const name of existingNames) {
          if (!submittedNames.has(name)) {
            await mcpSecretClient.deleteSecret(id, name);
          }
        }

        // Upsert only explicit new values; keep existing values when masked/empty.
        for (const [name, rawValue] of submittedEntries) {
          const valueStr = String(rawValue ?? "");
          if (valueStr && valueStr !== "<secret>") {
            await mcpSecretClient.storeSecret(id, name, valueStr);
          }
        }
      }

      if (headers !== undefined) {
        const submittedNames = new Set(headers.map((h) => h.name));

        // Delete secrets that the client explicitly removed (including all when headers is []).
        for (const name of existingNames) {
          if (!submittedNames.has(name)) {
            await mcpSecretClient.deleteSecret(id, name);
          }
        }

        // Upsert only explicit new values; keep existing values when masked/empty.
        for (const header of headers) {
          if (header.value && header.value !== "<secret>") {
            await mcpSecretClient.storeSecret(id, header.name, header.value);
          }
        }
      }
    }

    const updated = await ctx.mcpServerCollection.findOne({ _id: id });
    res.json({ ...updated, id: updated!._id });
  },
});

// DELETE /api/v1/mcp/servers/:id — soft-delete MCP server
apiRoute(ctx.app, ctx.registry, {
  method: "delete",
  path: "/api/v1/mcp/servers/:id",
  tags: ["MCP Servers"],
  summary: "Delete MCP server",
  params: z.object({ id: z.string() }),
  response: z.object({ message: z.string() }),
  successStatus: 204,
  handler: async (req, res) => {
    const { id } = req.params;

    const existing = await ctx.mcpServerCollection.findOne({
      _id: id,
      deletedAt: { $exists: false },
    });
    if (!existing) {
      res.status(404).json({ error: "MCP server not found" });
      return;
    }

    // Best-effort cleanup of secrets before soft-delete
    if (mcpSecretClient) {
      await mcpSecretClient.deleteAllSecrets(id);
    }

    await ctx.mcpServerCollection.updateOne(
      { _id: id },
      { $set: { deletedAt: new Date(), updatedAt: new Date() } },
    );

    res.status(204).send();
  },
});

}
