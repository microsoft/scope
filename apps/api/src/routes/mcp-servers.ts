// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  McpServerHeaderSchema,
  McpServerResponseSchema,
  McpTransportTypeSchema,
  UpdateMcpServerInputSchema,
} from "shared";
import { apiRoute } from "../openapi/api-route.js";
import type { McpServerDocument, RouteContext } from "../route-context.js";
import {
  ProjectIdQuerySchema,
  getQueryProjectId,
} from "../utils/project-scope.js";

export function registerMcpServersRoutes(ctx: RouteContext): void {

const { mcpSecretClient } = ctx;

/** Public identifier for a server = its human slug (falls back to legacy _id-as-slug rows). */
const mcpSlug = (s: McpServerDocument): string => s.slug ?? s._id;

/**
 * Map a stored server doc to the API response shape.
 *
 * After migration 027, `_id` is an internal random UUID and the human slug lives
 * in `slug`. The API contract speaks only in slugs, so we mask `_id` back to the
 * slug on the way out and never leak the internal UUID (`id` and `slug` both = the
 * human slug too). Legacy rows (pre-027) still have `_id === slug`, so masking is a
 * no-op for them. Mirrors `versionResponse` in profiles.ts.
 */
const toMcpResponse = (s: McpServerDocument): McpServerDocument & { id: string } => ({
  ...s,
  _id: mcpSlug(s),
  slug: mcpSlug(s),
  id: mcpSlug(s),
});

/**
 * Resolve a server by its human slug, **always scoped to a project**.
 *
 * New rows key `_id` to a random UUID and carry the slug in `slug`; legacy rows
 * (pre-migration 027) still have `_id === slug`. The lookup is confined to
 * `projectId` (slugs may repeat across projects), trying the `slug` field first
 * then the legacy `_id` for un-backfilled rows. There is **no global slug-only
 * fallback**: a project-scoped entity is never resolved by slug alone.
 */
const findServerBySlug = async (
  slug: string,
  projectId: string,
): Promise<McpServerDocument | null> => {
  const bySlug = await ctx.mcpServerCollection.findOne({
    projectId,
    slug,
    deletedAt: { $exists: false },
  });
  if (bySlug) return bySlug as McpServerDocument;
  return (await ctx.mcpServerCollection.findOne({
    projectId,
    _id: slug,
    deletedAt: { $exists: false },
  })) as McpServerDocument | null;
};

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
  query: ProjectIdQuerySchema,
  response: z.array(McpServerResponseSchema),
  handler: async (req, res) => {
    const servers = await ctx.mcpServerCollection
      .find({ projectId: getQueryProjectId(req), deletedAt: { $exists: false } })
      .toArray();
    servers.sort((a, b) => mcpSlug(a).localeCompare(mcpSlug(b)));
    res.json(servers.map((s) => toMcpResponse(s)));
  },
});

// GET /api/v1/mcp/servers/:id — get MCP server by slug
// When Token Manager is available, returns masked values for env/headers ("<secret>")
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/mcp/servers/:id",
  runToken: true,
  tags: ["MCP Servers"],
  summary: "Get MCP server",
  params: z.object({ id: z.string() }),
  query: ProjectIdQuerySchema,
  response: McpServerResponseSchema,
  handler: async (req, res) => {
    const server = await findServerBySlug(req.params.id, getQueryProjectId(req));
    if (!server) {
      res.status(404).json({ error: "MCP server not found" });
      return;
    }

    if (mcpSecretClient) {
      const items = await mcpSecretClient.listSecrets(server.projectId, mcpSlug(server));
      if (items.length > 0) {
        const masked = Object.fromEntries(items.map((item) => [item.name, "<secret>"]));
        // Return masked env or headers depending on transport type
        if (server.type === "stdio") {
          res.json({ ...toMcpResponse(server), env: masked });
        } else {
          const maskedHeaders = items.map((item) => ({ name: item.name, value: "<secret>" }));
          res.json({ ...toMcpResponse(server), headers: maskedHeaders });
        }
        return;
      }
    }

    res.json(toMcpResponse(server));
  },
});

// POST /api/v1/mcp/servers — create a new MCP server.
// A slug must be unique within its project: creating over an existing slug (active
// OR soft-deleted) is rejected with 409. Updating an existing server is the edit
// flow's job (PUT /:id); reviving a soft-deleted server is also done via edit, never
// by re-creating. env/headers are rejected with 503 if Token Manager is not available.
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/mcp/servers",
  tags: ["MCP Servers"],
  summary: "Create MCP server",
  query: ProjectIdQuerySchema,
  body: CreateMcpServerBodySchema,
  response: McpServerResponseSchema,
  handler: async (req, res) => {
    const projectId = getQueryProjectId(req);
    const { _id: slug, name, type, url, command, args, env, headers, sessionMode, version, description } = req.body;

    const hasSecrets = (env && Object.keys(env).length > 0) || (headers && headers.length > 0);
    if (hasSecrets && !mcpSecretClient) {
      res.status(503).json({ error: "Secret storage unavailable: TOKEN_MANAGER_URL is not configured" });
      return;
    }

    const now = new Date();
    // A slug must be unique within its project. Look up any existing server with this
    // slug — active OR soft-deleted (new rows carry `slug`; legacy pre-027 rows key
    // `_id` to the slug — match either). Creating over an existing slug is rejected:
    // updating an existing server is the edit flow (PUT /:id), and reviving a
    // soft-deleted one is also done via edit, never by re-creating. Slugs may repeat
    // across projects, so this only conflicts within the same project.
    const existing = await ctx.mcpServerCollection.findOne({
      projectId,
      $or: [{ slug }, { _id: slug }],
    });

    if (existing) {
      res.status(409).json({
        error: existing.deletedAt
          ? `An MCP server with slug '${slug}' was deleted in this project. Restore it from the edit flow instead of creating a new one.`
          : `An MCP server with slug '${slug}' already exists in this project.`,
      });
      return;
    }

    const serverDoc: McpServerDocument = {
      _id: randomUUID(),
      slug,
      projectId,
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

    // Store secrets in Token Manager — keyed by (projectId, mcpId=slug, name), not the
    // internal UUID _id. deleteAllSecrets first defensively clears any orphaned secrets
    // left behind by a previously hard-deleted server that reused this slug.
    if (mcpSecretClient && hasSecrets) {
      await mcpSecretClient.deleteAllSecrets(projectId, slug);
      if (env && Object.keys(env).length > 0) {
        await mcpSecretClient.storeEnv(projectId, slug, env);
      } else if (headers && headers.length > 0) {
        await mcpSecretClient.storeHeaders(projectId, slug, headers);
      }
    }

    const created = await ctx.mcpServerCollection.findOne({ projectId, slug });
    res.status(201).json(toMcpResponse(created as McpServerDocument));
  },
});

// PUT /api/v1/mcp/servers/:id — update MCP server
apiRoute(ctx.app, ctx.registry, {
  method: "put",
  path: "/api/v1/mcp/servers/:id",
  tags: ["MCP Servers"],
  summary: "Update MCP server",
  params: z.object({ id: z.string() }),
  query: ProjectIdQuerySchema,
  body: UpdateMcpServerInputSchema,
  response: McpServerResponseSchema,
  handler: async (req, res) => {
    const { id } = req.params;
    const { name, type, url, command, args, env, headers, sessionMode, version, description } = req.body;

    const existing = await findServerBySlug(id, getQueryProjectId(req));
    if (!existing) {
      res.status(404).json({ error: "MCP server not found" });
      return;
    }
    const realId = existing._id;
    const secretSlug = mcpSlug(existing);
    const secretProjectId = existing.projectId;

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

    await ctx.mcpServerCollection.updateOne({ _id: realId }, mongoUpdate);

    // When the transport kind changes (stdio ↔ non-stdio) and no explicit secret
    // reconciliation was requested, delete all existing secrets — GET would otherwise
    // re-interpret them as the wrong type (env ↔ headers).
    if (mcpSecretClient && typeChangesKind && !wantsSecretReconciliation) {
      const itemsToDelete = await mcpSecretClient.listSecrets(secretProjectId, secretSlug);
      await Promise.all(itemsToDelete.map((item) => mcpSecretClient!.deleteSecret(secretProjectId, secretSlug, item.name)));
    }

    // Reconcile secrets in Token Manager when secret fields are provided.
    // - Empty/`"<secret>"` values preserve the existing secret for that key.
    // - Keys omitted from the payload are deleted.
    // - An empty env object (`{}`) or empty headers array (`[]`) deletes all existing secrets.
    // Only one of env/headers may be present (enforced above).
    if (mcpSecretClient && wantsSecretReconciliation) {
      const existingItems = await mcpSecretClient.listSecrets(secretProjectId, secretSlug);
      const existingNames = new Set(existingItems.map((item) => item.name));

      if (env !== undefined) {
        const submittedEntries = Object.entries(env);
        const submittedNames = new Set(submittedEntries.map(([name]) => name));

        // Delete secrets that the client explicitly removed (including all when env is {}).
        for (const name of existingNames) {
          if (!submittedNames.has(name)) {
            await mcpSecretClient.deleteSecret(secretProjectId, secretSlug, name);
          }
        }

        // Upsert only explicit new values; keep existing values when masked/empty.
        for (const [name, rawValue] of submittedEntries) {
          const valueStr = String(rawValue ?? "");
          if (valueStr && valueStr !== "<secret>") {
            await mcpSecretClient.storeSecret(secretProjectId, secretSlug, name, valueStr);
          }
        }
      }

      if (headers !== undefined) {
        const submittedNames = new Set(headers.map((h) => h.name));

        // Delete secrets that the client explicitly removed (including all when headers is []).
        for (const name of existingNames) {
          if (!submittedNames.has(name)) {
            await mcpSecretClient.deleteSecret(secretProjectId, secretSlug, name);
          }
        }

        // Upsert only explicit new values; keep existing values when masked/empty.
        for (const header of headers) {
          if (header.value && header.value !== "<secret>") {
            await mcpSecretClient.storeSecret(secretProjectId, secretSlug, header.name, header.value);
          }
        }
      }
    }

    const updated = await ctx.mcpServerCollection.findOne({ _id: realId });
    res.json(toMcpResponse(updated as McpServerDocument));
  },
});

// DELETE /api/v1/mcp/servers/:id — soft-delete MCP server
apiRoute(ctx.app, ctx.registry, {
  method: "delete",
  path: "/api/v1/mcp/servers/:id",
  tags: ["MCP Servers"],
  summary: "Delete MCP server",
  params: z.object({ id: z.string() }),
  query: ProjectIdQuerySchema,
  response: z.object({ message: z.string() }),
  successStatus: 204,
  handler: async (req, res) => {
    const { id } = req.params;

    const existing = await findServerBySlug(id, getQueryProjectId(req));
    if (!existing) {
      res.status(404).json({ error: "MCP server not found" });
      return;
    }

    // Best-effort cleanup of secrets before soft-delete (keyed by projectId + slug)
    if (mcpSecretClient) {
      await mcpSecretClient.deleteAllSecrets(existing.projectId, mcpSlug(existing));
    }

    await ctx.mcpServerCollection.updateOne(
      { _id: existing._id },
      { $set: { deletedAt: new Date(), updatedAt: new Date() } },
    );

    res.status(204).send();
  },
});

}
