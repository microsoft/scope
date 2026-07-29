// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { BlobServiceClient, RestError } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";
import { join, basename } from "path";
import { z } from "zod";
import { CreateSkillInputSchema, SkillResponseSchema, SkillRevisionResponseSchema, SkillSearchResultSchema, SkillDiscoveryResultSchema } from "@scope/core";
import type { SkillDocument, SkillSearchResult } from "@scope/core";
import { apiRoute } from "../openapi/api-route.js";
import type { RouteContext } from "../route-context.js";

export function registerSkillsRoutes(ctx: RouteContext): void {

// =====================================================================
// Skills API
// =====================================================================

// Upload a skill archive to blob storage. Shared by manual /resolve and
// the auto-resolve triggered after a skill is created or imported.
const uploadSkillArchive = async (archiveName: string, data: Buffer): Promise<string> => {
  if (!ctx.storageConnectionString && !ctx.storageAccountName) {
    throw new Error("Blob storage not configured — cannot store skill archives");
  }

  let blobServiceClient: BlobServiceClient;
  if (ctx.storageConnectionString) {
    blobServiceClient = BlobServiceClient.fromConnectionString(ctx.storageConnectionString);
  } else {
    const credential = new DefaultAzureCredential();
    blobServiceClient = new BlobServiceClient(
      `https://${ctx.storageAccountName}.blob.core.windows.net`,
      credential
    );
  }

  const containerClient = blobServiceClient.getContainerClient("skill-archives");
  await containerClient.createIfNotExists();
  const blockBlobClient = containerClient.getBlockBlobClient(archiveName);
  await blockBlobClient.upload(data, data.length, {
    blobHTTPHeaders: { blobContentType: "application/gzip" },
  });
  return blockBlobClient.url;
};

// List all skills (with optional ?q= text search)
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/skills",
  tags: ["Skills"],
  summary: "List all skills",
  response: z.array(SkillResponseSchema),
  handler: async (_req, res, next) => {
    try {
      const skills = await ctx.skillCollection
        .find({ deletedAt: { $exists: false } })
        .toArray();
      skills.sort((a, b) => a._id.localeCompare(b._id));
      res.json(skills.map((s) => ({ ...s, id: s._id })));
    } catch (error) {
      next(error);
    }
  },
});

// Unified skill search — merges internal DB + skills.sh results
// MUST be defined before /:id(*) to avoid being caught by the wildcard
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/skills/search",
  tags: ["Skills"],
  summary: "Search skills (internal + external)",
  query: z.object({ q: z.string(), limit: z.string().optional() }),
  response: z.array(SkillSearchResultSchema),
  errorResponses: {
    400: { description: "Missing query parameter" },
  },
  handler: async (req, res, next) => {
    try {
      const { q, limit: limitStr } = req.query;

      if (!q || typeof q !== "string" || !q.trim()) {
        res.status(400).json({ error: "Query parameter 'q' is required" });
        return;
      }

      const limit = Math.min(Math.max(parseInt(limitStr as string, 10) || 10, 1), 50);
      const query = q.trim();

      // Search internal DB (case-insensitive regex)
      const regex = { $regex: query, $options: "i" };
      const internalSkills = await ctx.skillCollection
        .find({
          deletedAt: { $exists: false },
          $or: [
            { name: regex },
            { skillName: regex },
            { description: regex },
          ],
        })
        .limit(limit)
        .toArray();

      const internalResults: SkillSearchResult[] = internalSkills.map((s) => ({
        id: s._id,
        name: s.name,
        source: s.source,
        description: s.description,
        internal: true,
      }));

      // Also track internal slugs to deduplicate
      const internalSlugs = new Set(internalSkills.map((s) => s._id));

      // Search skills.sh (external registry)
      let externalResults: SkillSearchResult[] = [];
      try {
        const skillsShUrl = `https://skills.sh/api/search?q=${encodeURIComponent(query)}&limit=${limit}`;
        const externalRes = await fetch(skillsShUrl, {
          headers: { "User-Agent": "scope-mt-api" },
          signal: AbortSignal.timeout(5000),
        });
        if (externalRes.ok) {
          const data = await externalRes.json() as { skills?: Array<{ id: string; name: string; installs?: number; source?: string }> };
          if (data.skills && Array.isArray(data.skills)) {
            externalResults = data.skills
              .filter((s) => !internalSlugs.has(s.id))
              .map((s) => ({
                id: s.id,
                name: s.name,
                source: s.source ?? s.id.split("/").slice(0, 2).join("/"),
                internal: false,
                installs: s.installs,
              }));
          }
        }
      } catch {
        // skills.sh is optional — don't fail the request if it's down
        console.warn("skills.sh search failed, returning only internal results");
      }

      // Merge: internal first, then external
      const results = [...internalResults, ...externalResults].slice(0, limit);
      res.json(results);
    } catch (error) {
      next(error);
    }
  },
});

// Search external skills registry only (skills.sh)
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/skills/search/external",
  tags: ["Skills"],
  summary: "Search external skills registry",
  query: z.object({ q: z.string(), limit: z.string().optional() }),
  response: z.array(SkillSearchResultSchema),
  errorResponses: {
    400: { description: "Missing query parameter" },
  },
  handler: async (req, res, next) => {
    try {
      const { q, limit: limitStr } = req.query;

      if (!q || typeof q !== "string" || !q.trim()) {
        res.status(400).json({ error: "Query parameter 'q' is required" });
        return;
      }

      const limit = Math.min(Math.max(parseInt(limitStr as string, 10) || 10, 1), 50);
      const query = q.trim();

      let externalResults: SkillSearchResult[] = [];
      try {
        const skillsShUrl = `https://skills.sh/api/search?q=${encodeURIComponent(query)}&limit=${limit}`;
        const externalRes = await fetch(skillsShUrl, {
          headers: { "User-Agent": "scope-mt-api" },
          signal: AbortSignal.timeout(5000),
        });
        if (externalRes.ok) {
          const data = await externalRes.json() as { skills?: Array<{ id: string; name: string; installs?: number; source?: string; description?: string }> };
          if (data.skills && Array.isArray(data.skills)) {
            // Deduplicate against internal skills
            const internalSlugs = new Set(
              (await ctx.skillCollection.find({ deletedAt: { $exists: false } }, { projection: { _id: 1 } }).toArray()).map((s) => s._id)
            );
            externalResults = data.skills
              .filter((s) => !internalSlugs.has(s.id))
              .map((s) => ({
                id: s.id,
                name: s.name,
                source: s.source ?? s.id.split("/").slice(0, 2).join("/"),
                description: s.description,
                internal: false,
                installs: s.installs,
              }));
          }
        }
      } catch {
        console.warn("skills.sh search failed");
      }

      res.json(externalResults.slice(0, limit));
    } catch (error) {
      next(error);
    }
  },
});

// Discover skills available in a GitHub repo by scanning well-known directories.
// MUST be defined before /:id(*) to avoid being caught by the wildcard.
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/skills/discover",
  tags: ["Skills"],
  summary: "Discover skills in a GitHub repository",
  query: z.object({ source: z.string() }),
  response: z.array(SkillDiscoveryResultSchema),
  errorResponses: {
    400: { description: "Missing or malformed source parameter" },
    404: { description: "Repository not found" },
    502: { description: "GitHub API error" },
  },
  handler: async (req, res, next) => {
    try {
      const source = (req.query.source as string | undefined)?.trim();
      if (!source) {
        res.status(400).json({ error: "Query parameter 'source' is required (e.g. 'owner/repo')" });
        return;
      }
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source)) {
        res.status(400).json({ error: "source must be in the form 'owner/repo'" });
        return;
      }

      try {
        const results = await ctx.skillResolver.discoverSkills(source);

        // Enrich with library status: which skills are already imported, and
        // whether the most recent stored revision lags behind the current
        // upstream commit on `skillPath`. This drives the wizard's 3-state UI
        // (New / Up to date / Update available).
        const existingDocs = await ctx.skillCollection
          .find({ source, deletedAt: { $exists: false } }, { projection: { skillName: 1 } })
          .toArray();
        const existingNames = new Set(existingDocs.map((d) => d.skillName));

        const enriched = await Promise.all(
          results.map(async (r) => {
            if (!existingNames.has(r.skillName)) {
              return { ...r, existsInLibrary: false };
            }
            // Both calls are independent — run in parallel.
            const [latestRevs, upstreamSha] = await Promise.all([
              ctx.skillRevisionStore.listBySkill(source, r.skillName, { limit: 1 }),
              ctx.skillResolver.getLatestCommitSha(source, r.skillPath).catch(() => undefined),
            ]);
            const latest = latestRevs[0];
            const currentSha = latest?.commitHash;
            const updateAvailable =
              !!upstreamSha && !!currentSha && upstreamSha !== currentSha;
            return {
              ...r,
              existsInLibrary: true,
              ...(currentSha ? { currentRevisionCommitSha: currentSha } : {}),
              ...(upstreamSha ? { latestUpstreamCommitSha: upstreamSha } : {}),
              updateAvailable,
              ...(latest ? { lastImportedAt: latest.resolvedAt.toISOString() } : {}),
            };
          })
        );

        res.json(enriched);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/not found/i.test(message)) {
          res.status(404).json({ error: message });
          return;
        }
        res.status(502).json({ error: `GitHub discovery failed: ${message}` });
      }
    } catch (error) {
      next(error);
    }
  },
});

// List skill revisions for a given skill slug (source/skillName)
// NOTE: Must be before the generic GET /:id(*) to avoid the greedy wildcard matching "slug/revisions" as the id.
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/skills/:id(*)/revisions",
  tags: ["Skills"],
  summary: "List skill revisions",
  query: z.object({ limit: z.string().optional() }),
  response: z.array(SkillRevisionResponseSchema),
  errorResponses: {
    404: { description: "Skill not found" },
  },
  handler: async (req, res, next) => {
    try {
      const id = req.params.id ?? req.params[0];
      const skill = await ctx.skillCollection.findOne({ _id: id, deletedAt: { $exists: false } });
      if (!skill) {
        res.status(404).json({ error: "Skill not found" });
        return;
      }

      const limitStr = req.query.limit as string | undefined;
      const limit = Math.min(Math.max(parseInt(limitStr ?? "20", 10), 1), 100);

      const revisions = await ctx.skillRevisionStore.listBySkill(skill.source, skill.skillName, { limit });
      res.json(revisions);
    } catch (error) {
      next(error);
    }
  },
});

// Get skill by slug (must be after /search and /revisions to avoid wildcard matching)
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/skills/:id(*)",
  tags: ["Skills"],
  summary: "Get skill by slug",
  response: SkillResponseSchema,
  errorResponses: {
    404: { description: "Skill not found" },
  },
  handler: async (req, res, next) => {
    try {
      const id = req.params.id ?? req.params[0];
      const skill = await ctx.skillCollection.findOne({ _id: id, deletedAt: { $exists: false } });
      if (!skill) {
        res.status(404).json({ error: "Skill not found" });
        return;
      }
      res.json({ ...skill, id: skill._id });
    } catch (error) {
      next(error);
    }
  },
});

// Create / import a skill
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/skills",
  tags: ["Skills"],
  summary: "Create or import a skill",
  body: CreateSkillInputSchema,
  response: SkillResponseSchema,
  handler: async (req, res, next) => {
    try {
      const { source, skillName, name, description, origin } = req.body;

      if (!source || typeof source !== "string") {
        res.status(400).json({ error: "source is required and must be a string (GitHub repo, e.g. 'vercel-labs/agent-skills')" });
        return;
      }
      if (!skillName || typeof skillName !== "string") {
        res.status(400).json({ error: "skillName is required and must be a string" });
        return;
      }
      if (!name || typeof name !== "string") {
        res.status(400).json({ error: "name is required and must be a string" });
        return;
      }
      if (origin !== undefined && origin !== "skills-sh" && origin !== "manual") {
        res.status(400).json({ error: "origin must be 'skills-sh' or 'manual'" });
        return;
      }

      const _id = `${source}/${skillName}`;
      const now = new Date();
      const existing = await ctx.skillCollection.findOne({ _id });

      let responseSkill: SkillDocument & { id: string };
      let status = 200;
      if (existing) {
        // Upsert: un-delete if soft-deleted, update fields
        await ctx.skillCollection.updateOne(
          { _id },
          {
            $set: {
              name,
              source,
              skillName,
              ...(description !== undefined ? { description } : {}),
              ...(origin ? { origin } : {}),
              updatedAt: now,
            },
            $unset: { deletedAt: "" },
          }
        );
        const updated = await ctx.skillCollection.findOne({ _id });
        responseSkill = { ...(updated as SkillDocument), id: updated!._id };
      } else {
        const skillDoc: SkillDocument = {
          _id,
          source,
          skillName,
          name,
          ...(description ? { description } : {}),
          origin: origin || "manual",
          createdAt: now,
        };
        await ctx.skillCollection.insertOne(skillDoc as any);
        responseSkill = { ...skillDoc, id: skillDoc._id };
        status = 201;
      }

      // Auto-resolve from GitHub so the user doesn't need to click "Resolve".
      // Failures are non-fatal: the skill is already saved and the user can
      // retry resolution manually via POST /skills/:id/resolve.
      try {
        await ctx.skillResolver.resolve(source, skillName, ctx.skillRevisionStore, uploadSkillArchive);
      } catch (resolveError) {
        const message = resolveError instanceof Error ? resolveError.message : String(resolveError);
        console.warn(`Auto-resolve failed for skill ${_id}: ${message}`);
      }

      res.status(status).json(responseSkill);
    } catch (error) {
      next(error);
    }
  },
});

// Soft-delete a skill
apiRoute(ctx.app, ctx.registry, {
  method: "delete",
  path: "/api/v1/skills/:id(*)",
  tags: ["Skills"],
  summary: "Soft-delete a skill",
  response: z.any(),
  rawResponse: true,
  successStatus: 204,
  errorResponses: {
    404: { description: "Skill not found" },
  },
  handler: async (req, res, next) => {
    try {
      const id = req.params.id ?? req.params[0];

      const existing = await ctx.skillCollection.findOne({ _id: id, deletedAt: { $exists: false } });
      if (!existing) {
        res.status(404).json({ error: "Skill not found" });
        return;
      }

      await ctx.skillCollection.updateOne(
        { _id: id },
        { $set: { deletedAt: new Date(), updatedAt: new Date() } }
      );

      // Also delete all associated skill revisions
      await ctx.skillRevisionStore.deleteBySkill(existing.source, existing.skillName);

      res.status(204).send();
    } catch (error) {
      next(error);
    }
  },
});

// =====================================================================
// Skill Revisions API
// =====================================================================

// Download skill revision archive (tar.gz) by ref — used by workers to fetch skill files through the API
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/skill-revisions/by-ref/:ref(*)/archive",
  tags: ["Skill Revisions"],
  summary: "Download skill revision archive",
  response: z.any(),
  rawResponse: true,
  responseDescription: "Binary tar.gz archive",
  errorResponses: {
    404: { description: "Skill revision or archive not found" },
    500: { description: "Blob storage error" },
  },
  handler: async (req, res, next) => {
    try {
      const ref = req.params.ref ?? req.params[0];
      // Strip trailing "/archive" that Express includes in the wildcard match
      const cleanRef = ref.replace(/\/archive$/, "");
      const revision = await ctx.skillRevisionStore.getByRef(cleanRef);
      if (!revision) {
        res.status(404).json({ error: "Skill revision not found" });
        return;
      }

      if (!revision.archiveUrl) {
        res.status(404).json({ error: "Skill revision has no archive" });
        return;
      }

      // Parse the blob name from the archiveUrl
      // archiveUrl format: https://<account>.blob.core.windows.net/skill-archives/<blobName>
      // or Azurite: http://127.0.0.1:10000/devstoreaccount1/skill-archives/<blobName>
      const archiveUrlObj = new URL(revision.archiveUrl);
      const pathParts = archiveUrlObj.pathname.split("/").filter(Boolean);
      // pathParts: ["skill-archives", "<blobName>"] or ["devstoreaccount1", "skill-archives", "<blobName>"]
      const containerIdx = pathParts.indexOf("skill-archives");
      if (containerIdx === -1 || containerIdx >= pathParts.length - 1) {
        res.status(500).json({ error: "Cannot parse archive blob path" });
        return;
      }
      const blobName = pathParts.slice(containerIdx + 1).join("/");

      let blobServiceClient: BlobServiceClient;
      if (ctx.storageConnectionString) {
        blobServiceClient = BlobServiceClient.fromConnectionString(ctx.storageConnectionString);
      } else if (ctx.storageAccountName) {
        const credential = new DefaultAzureCredential();
        blobServiceClient = new BlobServiceClient(
          `https://${ctx.storageAccountName}.blob.core.windows.net`,
          credential
        );
      } else {
        res.status(500).json({ error: "Blob storage not configured" });
        return;
      }

      const containerClient = blobServiceClient.getContainerClient("skill-archives");
      const blobClient = containerClient.getBlobClient(blobName);

      const downloadResponse = await blobClient.download();
      if (!downloadResponse.readableStreamBody) {
        res.status(500).json({ error: "Failed to download archive from blob storage" });
        return;
      }

      res.setHeader("Content-Type", "application/gzip");
      res.setHeader("Content-Disposition", `attachment; filename="${blobName}"`);
      if (downloadResponse.contentLength !== undefined) {
        res.setHeader("Content-Length", downloadResponse.contentLength.toString());
      }

      downloadResponse.readableStreamBody.pipe(res);
    } catch (error) {
      if (error instanceof RestError && error.statusCode === 404) {
        res.status(404).json({ error: "Archive blob not found in storage" });
        return;
      }
      next(error);
    }
  },
});

// Get skill revision by human-readable ref
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/skill-revisions/by-ref/:ref(*)",
  tags: ["Skill Revisions"],
  summary: "Get skill revision by ref",
  response: SkillRevisionResponseSchema,
  errorResponses: {
    404: { description: "Skill revision not found" },
  },
  handler: async (req, res, next) => {
    try {
      const ref = req.params.ref ?? req.params[0];
      const revision = await ctx.skillRevisionStore.getByRef(ref);
      if (!revision) {
        res.status(404).json({ error: "Skill revision not found" });
        return;
      }
      res.json(revision);
    } catch (error) {
      next(error);
    }
  },
});

// Get skill revision by ID (UUIDv5)
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/skill-revisions/:id",
  tags: ["Skill Revisions"],
  summary: "Get skill revision by ID",
  response: SkillRevisionResponseSchema,
  errorResponses: {
    404: { description: "Skill revision not found" },
  },
  handler: async (req, res, next) => {
    try {
      const { id } = req.params;
      const revision = await ctx.skillRevisionStore.get(id);
      if (!revision) {
        res.status(404).json({ error: "Skill revision not found" });
        return;
      }
      res.json(revision);
    } catch (error) {
      next(error);
    }
  },
});

// Resolve a skill — trigger resolution from GitHub and create a revision
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/skills/:id(*)/resolve",
  tags: ["Skills"],
  summary: "Trigger skill resolution",
  response: SkillRevisionResponseSchema,
  errorResponses: {
    404: { description: "Skill not found" },
    500: { description: "Blob storage error" },
  },
  handler: async (req, res, next) => {
    try {
      const id = req.params.id ?? req.params[0];
      const skill = await ctx.skillCollection.findOne({ _id: id, deletedAt: { $exists: false } });
      if (!skill) {
        res.status(404).json({ error: "Skill not found" });
        return;
      }

      const revision = await ctx.skillResolver.resolve(skill.source, skill.skillName, ctx.skillRevisionStore, uploadSkillArchive);
      res.json(revision);
    } catch (error) {
      next(error);
    }
  },
});

}
