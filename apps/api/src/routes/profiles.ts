// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import {
  CreateProfileInputSchema,
  UpdateProfileIdentitySchema,
  ProfileResponseSchema,
  ProfileVersionResponseSchema,
  ProfileWithVersionResponseSchema,
  ExtensionClient,
  parseExtensionSpec,
} from "shared";
import type { ProfileDocument, ProfileVersionDocument, ResourceBindingSpec } from "shared";
import { apiRoute } from "../openapi/api-route.js";
import type { RouteContext } from "../route-context.js";
import { resolveSkillSpecs } from "../utils/skill-helpers.js";
import {
  requestedAgentCapabilities,
  validateAgentTarget,
} from "../utils/agent-helpers.js";
import { ProjectIdQuerySchema, getQueryProjectId } from "../utils/project-scope.js";

export function registerProfilesRoutes(ctx: RouteContext): void {

// =====================================================================
// Profiles API
// =====================================================================

/**
 * Normalize a stored profile-version doc for API responses.
 *
 * After migration 027, `_id` is an internal random UUID and the composite
 * `"<profileId>@<version>"` lives in `ref`. The API contract keeps surfacing the
 * composite as `_id` (its historical value and the format stored in
 * `requests.profileVersionId`), so we mask `_id` back to `ref` on the way out and
 * never leak the internal UUID. Legacy rows (pre-027) still have `_id === ref`.
 */
const versionResponse = <T extends ProfileVersionDocument>(v: T): T => ({
  ...v,
  _id: v.ref ?? v._id,
});

function normalizeResourceBindingSpecs(input: unknown): ResourceBindingSpec[] | undefined {
  if (!Array.isArray(input) || input.length === 0) return undefined;
  const specs = input
    .map((item) => {
      if (typeof item === "string") {
        const ref = item.trim();
        return ref ? { ref } : undefined;
      }
      if (item && typeof item === "object" && typeof (item as { ref?: unknown }).ref === "string") {
        const ref = (item as { ref: string }).ref.trim();
        if (!ref) return undefined;
        const params = (item as { params?: unknown }).params;
        return {
          ref,
          ...(params && typeof params === "object" ? { params: params as Record<string, string> } : {}),
        };
      }
      return undefined;
    })
    .filter((spec): spec is ResourceBindingSpec => spec !== undefined);
  return specs.length > 0 ? specs : undefined;
}

// POST /api/v1/profiles — create a new profile (+ version 1)
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/profiles",
  tags: ["Profiles"],
  summary: "Create a new profile",
  body: CreateProfileInputSchema,
  query: ProjectIdQuerySchema,
  response: ProfileWithVersionResponseSchema,
  handler: async (req, res, next) => {
    try {
      const { name, description, workerType, model, reasoningEffort, agentVersion, mcpServers, skillRevisions, resources, extensions } = req.body;
      const projectId = getQueryProjectId(req);
      const resourceBindings = normalizeResourceBindingSpecs(resources);

      // A profile must be self-sufficient to submit a run, which requires a
      // model. Agents that don't declare any supportedModels can't satisfy
      // that contract, so creating a profile for them is rejected upfront.
      const agentCheck = await validateAgentTarget(ctx.agentCollection, {
        workerType,
        requestedVersion: agentVersion,
        model,
        requireModel: true,
        subjectPlural: "profiles",
        requirements: requestedAgentCapabilities({
          reasoningEffort,
          mcpServers,
          skillRevisions,
          extensions,
        }),
        strictCapabilities: ctx.strictAgentCapabilities,
      });
      if (!agentCheck.ok) {
        const { ok: _ok, status, ...payload } = agentCheck;
        res.status(status).json(payload);
        return;
      }

      const now = new Date();
      const profileId = uuidv4();
      const versionRef = `${profileId}@1`;

      // Resolve extension versions (same pattern as run submission)
      let resolvedExtensions: string[] | undefined;
      if (extensions && extensions.length > 0) {
        const extensionClient = new ExtensionClient("");
        const resolvedSpecs: string[] = [];
        for (const spec of extensions) {
          const parsed = parseExtensionSpec(spec);
          if (parsed.version) {
            resolvedSpecs.push(`${parsed.id}@${parsed.version}`);
          } else {
            const versions = await extensionClient.getVersions(parsed.id, false);
            if (versions.length === 0) {
              res.status(422).json({ error: `No stable versions found for extension "${parsed.id}"` });
              return;
            }
            resolvedSpecs.push(`${parsed.id}@${versions[0].version}`);
          }
        }
        resolvedExtensions = resolvedSpecs;
      }

      // Resolve skill specs to pinned revision refs
      let resolvedSkillRevisions: string[] | undefined;
      if (skillRevisions && skillRevisions.length > 0) {
        const result = await resolveSkillSpecs(skillRevisions, ctx, projectId);
        if (result.error) {
          res.status(422).json({ error: result.error });
          return;
        }
        resolvedSkillRevisions = result.refs;
      }

      const profileDoc: ProfileDocument = {
        _id: profileId,
        projectId,
        name,
        ...(description ? { description } : {}),
        latestVersion: 1,
        createdAt: now,
      };

      const versionDoc: ProfileVersionDocument = {
        _id: uuidv4(),
        ref: versionRef,
        projectId,
        profileId,
        version: 1,
        workerType,
        model: agentCheck.model ?? model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        agentVersion: agentCheck.agentVersion,
        ...(mcpServers && mcpServers.length > 0 ? { mcpServers } : {}),
        ...(resolvedSkillRevisions && resolvedSkillRevisions.length > 0 ? { skillRevisions: resolvedSkillRevisions } : {}),
        ...(resourceBindings && resourceBindings.length > 0 ? { resources: resourceBindings } : {}),
        ...(resolvedExtensions && resolvedExtensions.length > 0 ? { extensions: resolvedExtensions } : {}),
        createdAt: now,
      };

      await ctx.profileCollection.insertOne(profileDoc);
      await ctx.profileVersionCollection.insertOne(versionDoc);

      res.status(201).json({ ...profileDoc, version: versionResponse(versionDoc) });
    } catch (error) {
      next(error);
    }
  },
});

// GET /api/v1/profiles — list profiles (latest version of each)
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/profiles",
  tags: ["Profiles"],
  summary: "List profiles",
  query: z.object({ workerType: z.string().optional() }).merge(ProjectIdQuerySchema),
  response: z.array(ProfileWithVersionResponseSchema),
  handler: async (req, res, next) => {
    try {
      const filter: Record<string, unknown> = { projectId: getQueryProjectId(req), deletedAt: { $exists: false } };
      const profiles = await ctx.profileCollection.find(filter).sort({ name: 1 }).toArray();

      const result = await Promise.all(
        profiles.map(async (profile) => {
          const latestVersion = await ctx.profileVersionCollection.findOne(
            { profileId: profile._id, version: profile.latestVersion },
          );
          return { ...profile, version: versionResponse(latestVersion!) };
        }),
      );

      // Filter by workerType if specified (applied post-join)
      const { workerType } = req.query;
      const filtered = workerType
        ? result.filter((p) => p.version.workerType === workerType)
        : result;

      res.json(filtered);
    } catch (error) {
      next(error);
    }
  },
});

// GET /api/v1/profiles/:profileId — get profile with latest version
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/profiles/:profileId",
  tags: ["Profiles"],
  summary: "Get profile with latest version",
  params: z.object({ profileId: z.string() }),
  response: ProfileWithVersionResponseSchema,
  handler: async (req, res, next) => {
    try {
      const profile = await ctx.profileCollection.findOne({
        _id: req.params.profileId,
        deletedAt: { $exists: false },
      });
      if (!profile) {
        res.status(404).json({ error: "Profile not found" });
        return;
      }
      const latestVersion = await ctx.profileVersionCollection.findOne(
        { profileId: profile._id, version: profile.latestVersion },
      );
      res.json({ ...profile, version: versionResponse(latestVersion!) });
    } catch (error) {
      next(error);
    }
  },
});

// GET /api/v1/profiles/:profileId/versions — list all versions
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/profiles/:profileId/versions",
  tags: ["Profiles"],
  summary: "List profile versions",
  params: z.object({ profileId: z.string() }),
  response: z.array(ProfileVersionResponseSchema),
  handler: async (req, res, next) => {
    try {
      const profile = await ctx.profileCollection.findOne({
        _id: req.params.profileId,
        deletedAt: { $exists: false },
      });
      if (!profile) {
        res.status(404).json({ error: "Profile not found" });
        return;
      }
      const versions = await ctx.profileVersionCollection
        .find({ profileId: profile._id })
        .sort({ version: -1 })
        .toArray();
      res.json(versions.map(versionResponse));
    } catch (error) {
      next(error);
    }
  },
});

// GET /api/v1/profiles/:profileId/versions/:version — get specific version
apiRoute(ctx.app, ctx.registry, {
  method: "get",
  path: "/api/v1/profiles/:profileId/versions/:version",
  tags: ["Profiles"],
  summary: "Get profile version",
  params: z.object({ profileId: z.string(), version: z.coerce.number() }),
  response: ProfileVersionResponseSchema,
  handler: async (req, res, next) => {
    try {
      const versionDoc = await ctx.profileVersionCollection.findOne({
        profileId: req.params.profileId,
        version: req.params.version,
      });
      if (!versionDoc) {
        res.status(404).json({ error: "Profile version not found" });
        return;
      }
      res.json(versionResponse(versionDoc));
    } catch (error) {
      next(error);
    }
  },
});

// POST /api/v1/profiles/:profileId — create a new version
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/profiles/:profileId",
  tags: ["Profiles"],
  summary: "Create new profile version",
  params: z.object({ profileId: z.string() }),
  body: CreateProfileInputSchema.omit({ name: true, description: true }),
  response: ProfileVersionResponseSchema,
  handler: async (req, res, next) => {
    try {
      const profile = await ctx.profileCollection.findOne({
        _id: req.params.profileId,
        deletedAt: { $exists: false },
      });
      if (!profile) {
        res.status(404).json({ error: "Profile not found" });
        return;
      }

      const { workerType, model, reasoningEffort, agentVersion, mcpServers, skillRevisions, resources, extensions } = req.body;
      const resourceBindings = normalizeResourceBindingSpecs(resources);

      // Same self-sufficiency rule as POST /profiles: a profile (and any new
      // version) must carry a model, so reject agents that don't expose any.
      const agentCheck = await validateAgentTarget(ctx.agentCollection, {
        workerType,
        requestedVersion: agentVersion,
        model,
        requireModel: true,
        subjectPlural: "profile versions",
        requirements: requestedAgentCapabilities({
          reasoningEffort,
          mcpServers,
          skillRevisions,
          extensions,
        }),
        strictCapabilities: ctx.strictAgentCapabilities,
      });
      if (!agentCheck.ok) {
        const { ok: _ok, status, ...payload } = agentCheck;
        res.status(status).json(payload);
        return;
      }

      const now = new Date();
      const newVersion = profile.latestVersion + 1;
      const versionRef = `${profile._id}@${newVersion}`;

      // Resolve extension versions
      let resolvedExtensions: string[] | undefined;
      if (extensions && extensions.length > 0) {
        const extensionClient = new ExtensionClient("");
        const resolvedSpecs: string[] = [];
        for (const spec of extensions) {
          const parsed = parseExtensionSpec(spec);
          if (parsed.version) {
            resolvedSpecs.push(`${parsed.id}@${parsed.version}`);
          } else {
            const versions = await extensionClient.getVersions(parsed.id, false);
            if (versions.length === 0) {
              res.status(422).json({ error: `No stable versions found for extension "${parsed.id}"` });
              return;
            }
            resolvedSpecs.push(`${parsed.id}@${versions[0].version}`);
          }
        }
        resolvedExtensions = resolvedSpecs;
      }

      // Resolve skill specs to pinned revision refs
      let resolvedSkillRevisions: string[] | undefined;
      if (skillRevisions && skillRevisions.length > 0) {
        const result = await resolveSkillSpecs(skillRevisions, ctx, profile.projectId);
        if (result.error) {
          res.status(422).json({ error: result.error });
          return;
        }
        resolvedSkillRevisions = result.refs;
      }

      const versionDoc: ProfileVersionDocument = {
        _id: uuidv4(),
        ref: versionRef,
        projectId: profile.projectId,
        profileId: profile._id,
        version: newVersion,
        workerType,
        model: agentCheck.model ?? model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        agentVersion: agentCheck.agentVersion,
        ...(mcpServers && mcpServers.length > 0 ? { mcpServers } : {}),
        ...(resolvedSkillRevisions && resolvedSkillRevisions.length > 0 ? { skillRevisions: resolvedSkillRevisions } : {}),
        ...(resourceBindings && resourceBindings.length > 0 ? { resources: resourceBindings } : {}),
        ...(resolvedExtensions && resolvedExtensions.length > 0 ? { extensions: resolvedExtensions } : {}),
        createdAt: now,
      };

      await ctx.profileVersionCollection.insertOne(versionDoc);
      await ctx.profileCollection.updateOne(
        { _id: profile._id },
        { $set: { latestVersion: newVersion, updatedAt: now } },
      );

      res.status(201).json(versionResponse(versionDoc));
    } catch (error) {
      next(error);
    }
  },
});

// PUT /api/v1/profiles/:profileId — update profile identity (name/description)
apiRoute(ctx.app, ctx.registry, {
  method: "put",
  path: "/api/v1/profiles/:profileId",
  tags: ["Profiles"],
  summary: "Update profile identity",
  params: z.object({ profileId: z.string() }),
  body: UpdateProfileIdentitySchema,
  response: ProfileResponseSchema,
  handler: async (req, res, next) => {
    try {
      const profile = await ctx.profileCollection.findOne({
        _id: req.params.profileId,
        deletedAt: { $exists: false },
      });
      if (!profile) {
        res.status(404).json({ error: "Profile not found" });
        return;
      }

      const updateFields: Record<string, unknown> = { updatedAt: new Date() };
      if (req.body.name !== undefined) updateFields.name = req.body.name;
      if (req.body.description !== undefined) updateFields.description = req.body.description;

      await ctx.profileCollection.updateOne({ _id: profile._id }, { $set: updateFields });
      const updated = await ctx.profileCollection.findOne({ _id: profile._id });
      res.json(updated!);
    } catch (error) {
      next(error);
    }
  },
});

// DELETE /api/v1/profiles/:profileId — soft-delete profile
apiRoute(ctx.app, ctx.registry, {
  method: "delete",
  path: "/api/v1/profiles/:profileId",
  tags: ["Profiles"],
  summary: "Delete profile",
  params: z.object({ profileId: z.string() }),
  response: z.object({ message: z.string() }),
  successStatus: 204,
  handler: async (req, res, next) => {
    try {
      const profile = await ctx.profileCollection.findOne({
        _id: req.params.profileId,
        deletedAt: { $exists: false },
      });
      if (!profile) {
        res.status(404).json({ error: "Profile not found" });
        return;
      }

      await ctx.profileCollection.updateOne(
        { _id: profile._id },
        { $set: { deletedAt: new Date(), updatedAt: new Date() } },
      );

      res.status(204).send();
    } catch (error) {
      next(error);
    }
  },
});

} // end registerProfilesRoutes
