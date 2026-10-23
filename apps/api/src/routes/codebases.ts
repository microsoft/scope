// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import multer from "multer";
import { z } from "zod";
import {
  CreateCodebaseInputSchema,
  UpdateCodebaseInputSchema,
  ResolveCodebaseRevisionInputSchema,
  CodebaseResponseSchema,
  CodebaseRevisionResponseSchema,
} from "shared";
import { apiRoute } from "../openapi/api-route.js";
import type { RouteContext } from "../route-context.js";
import { ProjectIdQuerySchema, getQueryProjectId } from "../utils/project-scope.js";
import {
  createCodebaseArchiveUploader,
  downloadCodebaseArchive,
} from "../utils/codebase-helpers.js";

/**
 * Validate a git `source` of the form `owner/repo`.
 *
 * Beyond the character allow-list, every path segment must be a real name —
 * `.` and `..` are rejected so a crafted `source` cannot traverse outside the
 * intended repo when interpolated into the GitHub API URL.
 */
export function isValidGitSource(source: string | undefined): source is string {
  if (!source || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source)) return false;
  return source.split("/").every((segment) => segment !== "." && segment !== "..");
}

/**
 * Map an archive extraction failure to an HTTP status:
 * - decompression-bomb / size-limit breach -> 413 Payload Too Large
 * - path-traversal / link escape           -> 422 Unprocessable Entity
 * - anything else                          -> 400 Bad Request
 */
function archiveErrorStatus(error: unknown): number {
  if ((error as { code?: string })?.code === "ARCHIVE_TOO_LARGE") return 413;
  const message = error instanceof Error ? error.message : String(error);
  if (/Refusing to extract/i.test(message)) return 422;
  return 400;
}

export function registerCodebasesRoutes(ctx: RouteContext): void {
  // Upload size is intentionally NOT capped here. The 1 MB limit is enforced at
  // the ingress edge (nginx `client_max_body_size`) as the single source of truth,
  // which rejects oversized uploads before they reach the API; the portal maps the
  // resulting 413 to a friendly message. Keeping one limit at the edge avoids drift
  // between two places that would both need updating.
  const upload = multer({ dest: tmpdir() });

  const uploadArchive = createCodebaseArchiveUploader({
    storageConnectionString: ctx.storageConnectionString,
    storageAccountName: ctx.storageAccountName,
  });

  // ===================================================================
  // Codebases API
  // ===================================================================

  // List all codebases
  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/codebases",
    tags: ["Codebases"],
    summary: "List all codebases",
    query: ProjectIdQuerySchema,
    response: z.array(CodebaseResponseSchema),
    handler: async (req, res, next) => {
      try {
        const codebases = await ctx.codebaseStore.list({ projectId: getQueryProjectId(req) });
        res.json(codebases.map((c) => ({ ...c, id: c._id })));
      } catch (error) {
        next(error);
      }
    },
  });

  // Create a codebase.
  //
  // Git codebases are created from JSON metadata. Archive codebases are created
  // atomically with their first revision: the request MUST be multipart and
  // include the `archive` file. If the archive is missing or the revision fails
  // to materialize, the just-created codebase is hard-deleted (rollback) so no
  // empty/unusable archive codebase is ever persisted.
  apiRoute(ctx.app, ctx.registry, {
    method: "post",
    path: "/api/v1/codebases",
    tags: ["Codebases"],
    summary: "Create a codebase (archive codebases require the archive file)",
    middleware: [upload.single("archive")],
    query: ProjectIdQuerySchema,
    response: CodebaseResponseSchema,
    rawResponse: true,
    successStatus: 201,
    errorResponses: {
      400: { description: "Invalid input or missing archive" },
    },
    handler: async (req, res, next) => {
      const file = (req as unknown as { file?: { path: string; originalname?: string } }).file;
      try {
        const parsed = CreateCodebaseInputSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error: "Invalid input",
            details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          });
          return;
        }
        const { name, slug, description, sourceType, source, defaultBranch, creator } = parsed.data;

        if (sourceType === "git" && !isValidGitSource(source)) {
          res.status(400).json({ error: "Git codebases require a 'source' in the form 'owner/repo'" });
          return;
        }
        if (sourceType === "archive" && !file?.path) {
          res.status(400).json({ error: "Archive codebases require an archive file (multipart field 'archive') at creation." });
          return;
        }

        const codebase = await ctx.codebaseStore.create({
          projectId: getQueryProjectId(req),
          name,
          ...(slug ? { slug } : {}),
          ...(description ? { description } : {}),
          sourceType,
          ...(source ? { source } : {}),
          ...(defaultBranch ? { defaultBranch } : {}),
          ...(creator ? { creator } : {}),
        });

        // For archive codebases, create the first revision in the same request.
        // Roll back (hard-delete) the codebase if revision creation fails so we
        // never leave behind an archive codebase with zero revisions.
        if (sourceType === "archive" && file?.path) {
          try {
            const buffer = readFileSync(file.path);
            const result = await ctx.codebaseResolver.createArchiveRevision(
              codebase,
              {
                buffer,
                ...(file.originalname ? { originalFilename: file.originalname } : {}),
                ...(creator ? { creator } : {}),
              },
              ctx.codebaseRevisionStore,
              uploadArchive
            );
            // Re-fetch so the response reflects the updated latestRevisionId /
            // revisionCounter set while creating the first revision.
            const fresh = (await ctx.codebaseStore.get(codebase._id)) ?? codebase;
            res.status(201).json({
              ...fresh,
              id: fresh._id,
              firstRevision: result.revision,
            });
            return;
          } catch (revisionError) {
            await ctx.codebaseStore.hardDelete(codebase._id);
            const message = revisionError instanceof Error ? revisionError.message : String(revisionError);
            res
              .status(archiveErrorStatus(revisionError))
              .json({ error: `Failed to create the first archive revision: ${message}` });
            return;
          }
        }

        // For git codebases, best-effort resolve of the latest revision so the
        // new codebase starts with a usable snapshot. Unlike archive codebases,
        // a resolve failure (bad repo, network, GitHub rate limit) does NOT fail
        // creation — a git codebase is valid with zero revisions and the user can
        // resolve manually later.
        if (sourceType === "git") {
          try {
            const result = await ctx.codebaseResolver.resolveGit(
              codebase,
              undefined,
              ctx.codebaseRevisionStore,
              uploadArchive,
              creator ? { creator } : undefined
            );
            const fresh = (await ctx.codebaseStore.get(codebase._id)) ?? codebase;
            res.status(201).json({ ...fresh, id: fresh._id, firstRevision: result.revision });
            return;
          } catch (resolveError) {
            const message = resolveError instanceof Error ? resolveError.message : String(resolveError);
            console.warn(`Auto-resolve of latest revision failed for git codebase ${codebase.slug}: ${message}`);
            // Fall through: return the created codebase without a first revision.
          }
        }

        res.status(201).json({ ...codebase, id: codebase._id });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/slug|source/i.test(message)) {
          res.status(400).json({ error: message });
          return;
        }
        next(error);
      } finally {
        if (file?.path && existsSync(file.path)) rmSync(file.path, { force: true });
      }
    },
  });

  // Get a codebase by id
  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/codebases/:id",
    tags: ["Codebases"],
    summary: "Get a codebase",
    response: CodebaseResponseSchema,
    errorResponses: { 404: { description: "Codebase not found" } },
    handler: async (req, res, next) => {
      try {
        const codebase = await ctx.codebaseStore.get(req.params.id);
        if (!codebase) {
          res.status(404).json({ error: "Codebase not found" });
          return;
        }
        res.json({ ...codebase, id: codebase._id });
      } catch (error) {
        next(error);
      }
    },
  });

  // Patch a codebase
  apiRoute(ctx.app, ctx.registry, {
    method: "patch",
    path: "/api/v1/codebases/:id",
    tags: ["Codebases"],
    summary: "Update a codebase",
    body: UpdateCodebaseInputSchema,
    response: CodebaseResponseSchema,
    errorResponses: { 404: { description: "Codebase not found" } },
    handler: async (req, res, next) => {
      try {
        const updated = await ctx.codebaseStore.update(req.params.id, req.body);
        if (!updated) {
          res.status(404).json({ error: "Codebase not found" });
          return;
        }
        res.json({ ...updated, id: updated._id });
      } catch (error) {
        next(error);
      }
    },
  });

  // Soft-delete a codebase
  apiRoute(ctx.app, ctx.registry, {
    method: "delete",
    path: "/api/v1/codebases/:id",
    tags: ["Codebases"],
    summary: "Delete a codebase",
    response: z.any(),
    rawResponse: true,
    successStatus: 204,
    errorResponses: { 404: { description: "Codebase not found" } },
    handler: async (req, res, next) => {
      try {
        const ok = await ctx.codebaseStore.softDelete(req.params.id);
        if (!ok) {
          res.status(404).json({ error: "Codebase not found" });
          return;
        }
        // Cascade the soft-delete to revisions: they are hidden from listings but
        // preserved so runs referencing a specific revision still resolve.
        await ctx.codebaseRevisionStore.softDeleteByCodebase(req.params.id);
        res.status(204).send();
      } catch (error) {
        next(error);
      }
    },
  });

  // List revisions for a codebase
  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/codebases/:id/revisions",
    tags: ["Codebases"],
    summary: "List codebase revisions",
    query: z.object({ limit: z.string().optional() }),
    response: z.array(CodebaseRevisionResponseSchema),
    errorResponses: { 404: { description: "Codebase not found" } },
    handler: async (req, res, next) => {
      try {
        const codebase = await ctx.codebaseStore.get(req.params.id);
        if (!codebase) {
          res.status(404).json({ error: "Codebase not found" });
          return;
        }
        const limitStr = req.query.limit as string | undefined;
        const limit = Math.min(Math.max(parseInt(limitStr ?? "50", 10), 1), 200);
        const revisions = await ctx.codebaseRevisionStore.listByCodebase(codebase._id, { limit });
        res.json(revisions);
      } catch (error) {
        next(error);
      }
    },
  });

  // Resolve a new git revision (snapshot the repo at a ref / "latest")
  apiRoute(ctx.app, ctx.registry, {
    method: "post",
    path: "/api/v1/codebases/:id/revisions",
    tags: ["Codebases"],
    summary: "Resolve a new git codebase revision",
    body: ResolveCodebaseRevisionInputSchema,
    response: CodebaseRevisionResponseSchema,
    successStatus: 201,
    errorResponses: {
      400: { description: "Not a git codebase" },
      404: { description: "Codebase not found" },
      502: { description: "GitHub resolution failed" },
    },
    handler: async (req, res, next) => {
      try {
        const codebase = await ctx.codebaseStore.get(req.params.id);
        if (!codebase) {
          res.status(404).json({ error: "Codebase not found" });
          return;
        }
        if (codebase.sourceType !== "git") {
          res.status(400).json({ error: "Only git codebases can resolve revisions; upload an archive instead" });
          return;
        }
        const { requestedRef, creator } = req.body;
        try {
          const result = await ctx.codebaseResolver.resolveGit(
            codebase,
            requestedRef,
            ctx.codebaseRevisionStore,
            uploadArchive,
            creator ? { creator } : undefined
          );
          res
            .status(result.deduplicated ? 200 : 201)
            .json({ ...result.revision, deduplicated: result.deduplicated });
        } catch (resolveError) {
          const message = resolveError instanceof Error ? resolveError.message : String(resolveError);
          if (/not found/i.test(message)) {
            res.status(404).json({ error: message });
            return;
          }
          res.status(502).json({ error: `GitHub resolution failed: ${message}` });
        }
      } catch (error) {
        next(error);
      }
    },
  });

  // Upload an archive → create a new archive revision
  apiRoute(ctx.app, ctx.registry, {
    method: "post",
    path: "/api/v1/codebases/:id/upload",
    tags: ["Codebases"],
    summary: "Upload a codebase archive as a new revision",
    middleware: [upload.single("archive")],
    response: CodebaseRevisionResponseSchema,
    rawResponse: true,
    successStatus: 201,
    errorResponses: {
      400: { description: "Missing archive or not an archive codebase" },
      404: { description: "Codebase not found" },
    },
    handler: async (req, res, next) => {
      const file = (req as unknown as { file?: { path: string; originalname?: string } }).file;
      try {
        const codebase = await ctx.codebaseStore.get(req.params.id);
        if (!codebase) {
          res.status(404).json({ error: "Codebase not found" });
          return;
        }
        if (codebase.sourceType !== "archive") {
          res.status(400).json({ error: "Only archive codebases accept uploads; resolve a git revision instead" });
          return;
        }
        if (!file?.path) {
          res.status(400).json({ error: "No archive file uploaded. Use multipart field 'archive'." });
          return;
        }
        const buffer = readFileSync(file.path);
        const creator = ((req.body as Record<string, unknown> | undefined)?.creator as string | undefined) ?? undefined;
        const result = await ctx.codebaseResolver.createArchiveRevision(
          codebase,
          {
            buffer,
            ...(file.originalname ? { originalFilename: file.originalname } : {}),
            ...(creator ? { creator } : {}),
          },
          ctx.codebaseRevisionStore,
          uploadArchive
        );
        res
          .status(result.deduplicated ? 200 : 201)
          .json({ ...result.revision, deduplicated: result.deduplicated });
      } catch (error) {
        const status = archiveErrorStatus(error);
        if (status !== 400) {
          const message = error instanceof Error ? error.message : String(error);
          res.status(status).json({ error: message });
          return;
        }
        next(error);
      } finally {
        if (file?.path && existsSync(file.path)) rmSync(file.path, { force: true });
      }
    },
  });

  // ===================================================================
  // Codebase Revisions API
  // ===================================================================

  // Download a codebase revision archive (tar.gz) — used by workers to seed
  // the workspace. MUST be registered before GET /:id to avoid wildcard capture.
  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/codebase-revisions/:id/archive",
    runToken: true,
    tags: ["Codebase Revisions"],
    summary: "Download codebase revision archive",
    response: z.any(),
    rawResponse: true,
    responseDescription: "Binary tar.gz archive",
    errorResponses: {
      404: { description: "Revision or archive not found" },
      500: { description: "Blob storage error" },
    },
    handler: async (req, res, next) => {
      try {
        const revision = await ctx.codebaseRevisionStore.get(req.params.id);
        if (!revision) {
          res.status(404).json({ error: "Codebase revision not found" });
          return;
        }
        if (!revision.archiveUrl) {
          res.status(404).json({ error: "Codebase revision has no archive" });
          return;
        }
        const buffer = await downloadCodebaseArchive(revision.archiveUrl, {
          storageConnectionString: ctx.storageConnectionString,
          storageAccountName: ctx.storageAccountName,
        });
        res.setHeader("Content-Type", "application/gzip");
        res.setHeader("Content-Disposition", `attachment; filename="${revision._id}.tar.gz"`);
        res.setHeader("Content-Length", buffer.length.toString());
        res.send(buffer);
      } catch (error) {
        next(error);
      }
    },
  });

  // Get a codebase revision by id
  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/codebase-revisions/:id",
    runToken: true,
    tags: ["Codebase Revisions"],
    summary: "Get codebase revision by id",
    response: CodebaseRevisionResponseSchema,
    errorResponses: { 404: { description: "Revision not found" } },
    handler: async (req, res, next) => {
      try {
        const revision = await ctx.codebaseRevisionStore.get(req.params.id);
        if (!revision) {
          res.status(404).json({ error: "Codebase revision not found" });
          return;
        }
        res.json(revision);
      } catch (error) {
        next(error);
      }
    },
  });
}
