// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { CreateProfileInputSchema, UpdateProfileIdentitySchema, ProfileResponseSchema, ProfileVersionResponseSchema, ProfileWithVersionResponseSchema } from "@scope/core";
import { ExtensionClient, parseExtensionSpec } from "@scope/platform";
import type { ProfileDocument, ProfileVersionDocument } from "@scope/core";
import { apiRoute } from "../openapi/api-route.js";
import type { RouteContext } from "../route-context.js";
import { resolveSkillSpecs } from "../utils/skill-helpers.js";

export function registerProfilesRoutes(ctx: RouteContext): void {

// =====================================================================
// Profiles API
// =====================================================================

// POST /api/v1/profiles — create a new profile (+ version 1)
apiRoute(ctx.app, ctx.registry, {
  method: "post",
  path: "/api/v1/profiles",
  tags: ["Profiles"],
  summary: "Create a new profile",
  body: CreateProfileInputSchema,
  response: ProfileWithVersionResponseSchema,
  handler: async (req, res, next) => {
    try {
      const { name, description, workerType, model, agentVersion, mcpServers, skillRevisions, extensions } = req.body;

      // Extensions are only supported by VS Code workers
      if (extensions && extensions.length > 0 && !workerType.includes("vscode")) {
        res.status(400).json({ error: `Worker type "${workerType}" does not support VS Code extensions` });
        return;
      }

      const now = new Date();
      const profileId = uuidv4();
      const versionId = `${profileId}@1`;

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
        const result = await resolveSkillSpecs(skillRevisions, ctx);
        if (result.error) {
          res.status(422).json({ error: result.error });
          return;
        }
        resolvedSkillRevisions = result.refs;
      }

      const profileDoc: ProfileDocument = {
        _id: profileId,
        name,
        ...(description ? { description } : {}),
        latestVersion: 1,
        createdAt: now,
      };

      const versionDoc: ProfileVersionDocument = {
        _id: versionId,
        profileId,
        version: 1,
        workerType,
        model,
        ...(agentVersion ? { agentVersion } : {}),
        ...(mcpServers && mcpServers.length > 0 ? { mcpServers } : {}),
        ...(resolvedSkillRevisions && resolvedSkillRevisions.length > 0 ? { skillRevisions: resolvedSkillRevisions } : {}),
        ...(resolvedExtensions && resolvedExtensions.length > 0 ? { extensions: resolvedExtensions } : {}),
        createdAt: now,
      };

      await ctx.profileCollection.insertOne(profileDoc);
      await ctx.profileVersionCollection.insertOne(versionDoc);

      res.status(201).json({ ...profileDoc, version: versionDoc });
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
  query: z.object({ workerType: z.string().optional() }),
  response: z.array(ProfileWithVersionResponseSchema),
  handler: async (req, res, next) => {
    try {
      const filter: Record<string, unknown> = { deletedAt: { $exists: false } };
      const profiles = await ctx.profileCollection.find(filter).sort({ name: 1 }).toArray();

      const result = await Promise.all(
        profiles.map(async (profile) => {
          const latestVersion = await ctx.profileVersionCollection.findOne(
            { profileId: profile._id, version: profile.latestVersion },
          );
          return { ...profile, version: latestVersion! };
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
      res.json({ ...profile, version: latestVersion! });
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
      res.json(versions);
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
      res.json(versionDoc);
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

      const { workerType, model, agentVersion, mcpServers, skillRevisions, extensions } = req.body;

      // Extensions are only supported by VS Code workers
      if (extensions && extensions.length > 0 && !workerType.includes("vscode")) {
        res.status(400).json({ error: `Worker type "${workerType}" does not support VS Code extensions` });
        return;
      }

      const now = new Date();
      const newVersion = profile.latestVersion + 1;
      const versionId = `${profile._id}@${newVersion}`;

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
        const result = await resolveSkillSpecs(skillRevisions, ctx);
        if (result.error) {
          res.status(422).json({ error: result.error });
          return;
        }
        resolvedSkillRevisions = result.refs;
      }

      const versionDoc: ProfileVersionDocument = {
        _id: versionId,
        profileId: profile._id,
        version: newVersion,
        workerType,
        model,
        ...(agentVersion ? { agentVersion } : {}),
        ...(mcpServers && mcpServers.length > 0 ? { mcpServers } : {}),
        ...(resolvedSkillRevisions && resolvedSkillRevisions.length > 0 ? { skillRevisions: resolvedSkillRevisions } : {}),
        ...(resolvedExtensions && resolvedExtensions.length > 0 ? { extensions: resolvedExtensions } : {}),
        createdAt: now,
      };

      await ctx.profileVersionCollection.insertOne(versionDoc);
      await ctx.profileCollection.updateOne(
        { _id: profile._id },
        { $set: { latestVersion: newVersion, updatedAt: now } },
      );

      res.status(201).json(versionDoc);
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
