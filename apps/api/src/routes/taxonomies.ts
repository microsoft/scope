// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  CopyBuiltinTaxonomyRevisionInputSchema,
  CreateTaxonomyElementInputSchema,
  CreateTaxonomyElementRevisionInputSchema,
  CreateTaxonomyInputSchema,
  CreateTaxonomyRevisionInputSchema,
  PortableTaxonomyElementSchema,
  PortableTaxonomySchema,
  TaxonomyElementResponseSchema,
  TaxonomyElementRevisionResponseSchema,
  TaxonomyDetailResponseSchema,
  TaxonomyListItemResponseSchema,
  TaxonomyResponseSchema,
  TaxonomyRevisionResponseSchema,
  UpdateTaxonomyMetadataInputSchema,
  type PortableTaxonomyDocument,
  type TaxonomyDocument,
  type TaxonomyElementDocument,
  type TaxonomyDetail,
  type TaxonomyListItem,
} from "shared";
import { apiRoute } from "../openapi/api-route.js";
import type { RouteContext } from "../route-context.js";
import {
  ProjectIdQuerySchema,
  getQueryProjectId,
} from "../utils/project-scope.js";
import { ensureBuiltinTaxonomy } from "../taxonomy-builtin-seeder.js";

const ImportTaxonomyYamlInputSchema = z
  .object({
    name: z.string().trim().min(1).max(256),
    description: z.string().max(4096).optional(),
    creator: z.string().optional(),
    taxonomyYaml: z.string().min(1),
    elements: z.record(z.string(), z.string()).default({}),
  })
  .strict()
  .openapi("ImportTaxonomyYamlInput");

const TaxonomyDetailQuerySchema = ProjectIdQuerySchema.extend({
  revisionId: z.string().optional(),
}).openapi("TaxonomyDetailQuery");

export type TaxonomyRouteStores = Pick<
  RouteContext,
  | "taxonomyStore"
  | "taxonomyRevisionStore"
  | "taxonomyElementStore"
  | "taxonomyElementRevisionStore"
>;

/** Taxonome entry points are hidden unless the operator explicitly enables them. */
async function requireTaxonome(ctx: RouteContext, response: {
  status(code: number): { json(body: unknown): void };
}): Promise<boolean> {
  const flag = await ctx.featureFlagCollection.findOne({
    key: "taxonome",
    enabled: true,
  });
  if (!flag) {
    response.status(404).json({ error: "Taxonome is not enabled" });
    return false;
  }
  return true;
}

function assertUserRoot(
  root: TaxonomyDocument | TaxonomyElementDocument,
): void {
  if (root.sourceType !== "user") {
    throw new Error("Built-in taxonomy content is read-only");
  }
}

function portableTaxonomyRevision(revision: {
  schema_version: "scope/taxonomy/v1";
  id: string;
  version: string;
  surfaces: PortableTaxonomyDocument["surfaces"];
  elements: PortableTaxonomyDocument["elements"];
}): PortableTaxonomyDocument {
  return {
    schema_version: revision.schema_version,
    id: revision.id,
    version: revision.version,
    surfaces: revision.surfaces,
    elements: revision.elements,
  };
}

async function validateResolvedTaxonomyElements(
  ctx: RouteContext,
  projectId: string,
  content: PortableTaxonomyDocument,
): Promise<string | undefined> {
  const elementIds = new Set<string>();
  for (const reference of content.elements) {
    if ("path" in reference) {
      return `Unresolved element path '${reference.path}'; use the YAML import endpoint`;
    }
    const revision = await ctx.taxonomyElementRevisionStore.getByRef(
      projectId,
      reference.ref,
    );
    if (!revision) {
      return `Element revision '${reference.ref}' was not found in this project`;
    }
    if (elementIds.has(revision.id)) {
      return `Duplicate element id '${revision.id}'`;
    }
    elementIds.add(revision.id);
  }
  return undefined;
}

/** Builds list rows with one bulk latest-revision read, avoiding per-row lookups. */
export async function listTaxonomyRows(
  ctx: TaxonomyRouteStores,
  projectId: string,
): Promise<TaxonomyListItem[]> {
  const roots = await ctx.taxonomyStore.list(projectId);
  const revisions = await ctx.taxonomyRevisionStore.getMany(
    roots.flatMap(root => root.latestRevisionId ? [root.latestRevisionId] : []),
  );
  const revisionsById = new Map(revisions.map(revision => [
    revision._id,
    revision,
  ]));
  return roots.map(root => {
    const revision = root.latestRevisionId
      ? revisionsById.get(root.latestRevisionId)
      : undefined;
    if (!revision) {
      throw new Error(`Taxonomy root '${root._id}' has no latest revision`);
    }
    return {
      ...root,
      ref: revision.ref,
      version: revision.version,
      elementCount: revision.elements.length,
    };
  });
}

/**
 * Resolves one taxonomy revision and its exact ordered element revision vector
 * using bulk reads scoped to the taxonomy's project.
 */
export async function resolveTaxonomyDetail(
  ctx: TaxonomyRouteStores,
  projectId: string,
  taxonomyId: string,
  revisionId?: string,
): Promise<TaxonomyDetail | null> {
  const taxonomy = await ctx.taxonomyStore.get(taxonomyId, true);
  if (!taxonomy || taxonomy.projectId !== projectId) return null;

  const revisions = await ctx.taxonomyRevisionStore.list(taxonomy._id);
  const selectedRevision = revisionId
    ? revisions.find(revision =>
        revision._id === revisionId ||
        revision.ref === revisionId ||
        String(revision.revision) === revisionId
      )
    : revisions.find(revision =>
        revision._id === taxonomy.latestRevisionId
      ) ?? revisions[0];
  if (!selectedRevision) return null;

  const refs = selectedRevision.elements.map(reference => {
    if (!("ref" in reference)) {
      throw new Error(
        `Stored taxonomy revision '${selectedRevision.ref}' contains unresolved element paths`,
      );
    }
    return reference.ref;
  });
  const elementRevisions = await ctx.taxonomyElementRevisionStore.getByRefs(
    projectId,
    refs,
  );
  const revisionsByRef = new Map(elementRevisions.map(revision => [
    revision.ref,
    revision,
  ]));
  const elementRoots = await ctx.taxonomyElementStore.getMany(
    elementRevisions.map(revision => revision.elementId),
    true,
  );
  const rootsById = new Map(elementRoots.map(root => [root._id, root]));
  const elements = refs.map((ref, position) => {
    const revision = revisionsByRef.get(ref);
    if (!revision) {
      throw new Error(
        `Element revision '${ref}' referenced by '${selectedRevision.ref}' was not found`,
      );
    }
    const root = rootsById.get(revision.elementId);
    if (!root || root.projectId !== projectId) {
      throw new Error(`Element root for '${ref}' was not found in this project`);
    }
    return { position, root, revision };
  });

  return {
    taxonomy,
    selectedRevision,
    revisions: revisions.map(revision => ({
      _id: revision._id,
      revision: revision.revision,
      ref: revision.ref,
      version: revision.version,
      elementCount: revision.elements.length,
      contentSha256: revision.contentSha256,
      ...(revision.creator ? { creator: revision.creator } : {}),
      createdAt: revision.createdAt,
      isLatest: revision._id === taxonomy.latestRevisionId,
    })),
    elements,
  };
}

/** Registers the complete project-scoped taxonomy and element product API. */
export function registerTaxonomyRoutes(ctx: RouteContext): void {
  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/taxonomy-elements",
    tags: ["Taxonomies"],
    summary: "List project taxonomy elements",
    query: ProjectIdQuerySchema,
    response: z.array(TaxonomyElementResponseSchema),
    handler: async (req, res, next) => {
      try {
        if (!(await requireTaxonome(ctx, res))) return;
        await ensureBuiltinTaxonomy(ctx, getQueryProjectId(req));
        res.json(
          await ctx.taxonomyElementStore.list(getQueryProjectId(req)),
        );
      } catch (error) {
        next(error);
      }
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "post",
    path: "/api/v1/taxonomy-elements",
    tags: ["Taxonomies"],
    summary: "Create a user taxonomy element and revision 1",
    query: ProjectIdQuerySchema,
    body: CreateTaxonomyElementInputSchema,
    response: TaxonomyElementResponseSchema,
    successStatus: 201,
    handler: async (req, res, next) => {
      try {
        if (!(await requireTaxonome(ctx, res))) return;
        if (req.body.sourceType !== "user") {
          res.status(400).json({ error: "Only user taxonomy elements can be created" });
          return;
        }
        if (req.body.id && req.body.id !== req.body.content.id) {
          res.status(400).json({ error: "Root id must match content id" });
          return;
        }
        const root = await ctx.taxonomyElementStore.create({
          projectId: getQueryProjectId(req),
          id: req.body.content.id,
          name: req.body.name,
          ...(req.body.description
            ? { description: req.body.description }
            : {}),
          sourceType: "user",
          ...(req.body.creator ? { creator: req.body.creator } : {}),
        });
        await ctx.taxonomyElementRevisionStore.create(
          root._id,
          req.body.content,
          req.body.creator,
        );
        res
          .status(201)
          .json((await ctx.taxonomyElementStore.get(root._id)) ?? root);
      } catch (error) {
        next(error);
      }
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/taxonomies",
    tags: ["Taxonomies"],
    summary: "List project taxonomies",
    query: ProjectIdQuerySchema,
    response: z.array(TaxonomyListItemResponseSchema),
    handler: async (req, res, next) => {
      try {
        if (!(await requireTaxonome(ctx, res))) return;
        await ensureBuiltinTaxonomy(ctx, getQueryProjectId(req));
        res.json(await listTaxonomyRows(ctx, getQueryProjectId(req)));
      } catch (error) {
        next(error);
      }
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/taxonomies/:id/detail",
    tags: ["Taxonomies"],
    summary: "Get taxonomy detail with exact ordered element revisions",
    query: TaxonomyDetailQuerySchema,
    response: TaxonomyDetailResponseSchema,
    handler: async (req, res, next) => {
      try {
        if (!(await requireTaxonome(ctx, res))) return;
        const detail = await resolveTaxonomyDetail(
          ctx,
          getQueryProjectId(req),
          req.params.id,
          req.query.revisionId,
        );
        if (!detail) {
          res.status(404).json({ error: "Taxonomy or revision not found" });
          return;
        }
        res.json(detail);
      } catch (error) {
        next(error);
      }
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/taxonomy-element-revisions/:revisionId/export",
    tags: ["Taxonomies"],
    summary: "Export an exact taxonomy element revision as portable YAML",
    response: z.string(),
    rawResponse: true,
    handler: async (req, res, next) => {
      try {
        if (!(await requireTaxonome(ctx, res))) return;
        const revision = await ctx.taxonomyElementRevisionStore.get(
          req.params.revisionId,
        );
        if (!revision) {
          res.status(404).json({ error: "Taxonomy element revision not found" });
          return;
        }
        const {
          _id: _id,
          elementId: _elementId,
          projectId: _projectId,
          sourceType: _sourceType,
          revision: _revision,
          ref: _ref,
          contentSha256: _contentSha256,
          creator: _creator,
          createdAt: _createdAt,
          ...portable
        } = revision;
        res.type("application/yaml").send(stringifyYaml(portable));
      } catch (error) {
        next(error);
      }
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "post",
    path: "/api/v1/taxonomies",
    tags: ["Taxonomies"],
    summary: "Create a user taxonomy and revision 1",
    query: ProjectIdQuerySchema,
    body: CreateTaxonomyInputSchema,
    response: TaxonomyResponseSchema,
    successStatus: 201,
    handler: async (req, res, next) => {
      try {
        if (!(await requireTaxonome(ctx, res))) return;
        if (req.body.sourceType !== "user") {
          res.status(400).json({ error: "Only user taxonomies can be created" });
          return;
        }
        if (req.body.id && req.body.id !== req.body.content.id) {
          res.status(400).json({ error: "Root id must match content id" });
          return;
        }
        const elementError = await validateResolvedTaxonomyElements(
          ctx,
          getQueryProjectId(req),
          req.body.content,
        );
        if (elementError) {
          res.status(400).json({ error: elementError });
          return;
        }
        const root = await ctx.taxonomyStore.create({
          projectId: getQueryProjectId(req),
          id: req.body.content.id,
          name: req.body.name,
          ...(req.body.description
            ? { description: req.body.description }
            : {}),
          sourceType: "user",
          ...(req.body.creator ? { creator: req.body.creator } : {}),
        });
        await ctx.taxonomyRevisionStore.create(
          root._id,
          req.body.content,
          req.body.creator,
        );
        res.status(201).json((await ctx.taxonomyStore.get(root._id)) ?? root);
      } catch (error) {
        next(error);
      }
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "post",
    path: "/api/v1/taxonomies/import",
    tags: ["Taxonomies"],
    summary: "Import taxonomy YAML and referenced element YAML",
    query: ProjectIdQuerySchema,
    body: ImportTaxonomyYamlInputSchema,
    response: TaxonomyResponseSchema,
    successStatus: 201,
    handler: async (req, res, next) => {
      try {
        if (!(await requireTaxonome(ctx, res))) return;
        const taxonomy = PortableTaxonomySchema.parse(
          parseYaml(req.body.taxonomyYaml),
        );
        const projectId = getQueryProjectId(req);
        const refs: Array<{ ref: string }> = [];
        const ids = new Set<string>();

        for (const reference of taxonomy.elements) {
          if ("ref" in reference) {
            const resolved = await ctx.taxonomyElementRevisionStore.getByRef(
              projectId,
              reference.ref,
            );
            if (!resolved) {
              res.status(400).json({
                error: `Element revision '${reference.ref}' was not found in this project`,
              });
              return;
            }
            if (ids.has(resolved.id)) {
              res.status(400).json({ error: `Duplicate element id '${resolved.id}'` });
              return;
            }
            ids.add(resolved.id);
            refs.push({ ref: reference.ref });
            continue;
          }

          const yaml = req.body.elements[reference.path];
          if (!yaml) {
            res.status(400).json({
              error: `Missing element file '${reference.path}'`,
            });
            return;
          }
          const content = PortableTaxonomyElementSchema.parse(parseYaml(yaml));
          if (ids.has(content.id)) {
            res.status(400).json({ error: `Duplicate element id '${content.id}'` });
            return;
          }
          ids.add(content.id);
          const element = await ctx.taxonomyElementStore.create({
            projectId,
            id: content.id,
            name: content.label,
            ...(content.description ? { description: content.description } : {}),
            sourceType: "user",
            ...(req.body.creator ? { creator: req.body.creator } : {}),
          });
          const created = await ctx.taxonomyElementRevisionStore.create(
            element._id,
            content,
            req.body.creator,
          );
          refs.push({ ref: created.revision.ref });
        }

        const root = await ctx.taxonomyStore.create({
          projectId,
          id: taxonomy.id,
          name: req.body.name,
          ...(req.body.description
            ? { description: req.body.description }
            : {}),
          sourceType: "user",
          ...(req.body.creator ? { creator: req.body.creator } : {}),
        });
        await ctx.taxonomyRevisionStore.create(
          root._id,
          { ...taxonomy, elements: refs },
          req.body.creator,
        );
        res.status(201).json((await ctx.taxonomyStore.get(root._id)) ?? root);
      } catch (error) {
        next(error);
      }
    },
  });

  for (const operation of [
    { path: "/api/v1/taxonomies/:id", element: false },
    { path: "/api/v1/taxonomy-elements/:id", element: true },
  ] as const) {
    const responseSchema = operation.element
      ? TaxonomyElementResponseSchema
      : TaxonomyResponseSchema;

    apiRoute(ctx.app, ctx.registry, {
      method: "get",
      path: operation.path,
      tags: ["Taxonomies"],
      summary: `Get a taxonomy${operation.element ? " element" : ""}`,
      response: responseSchema,
      handler: async (req, res, next) => {
        try {
          if (!(await requireTaxonome(ctx, res))) return;
          const rootStore = operation.element
            ? ctx.taxonomyElementStore
            : ctx.taxonomyStore;
          const root = await rootStore.get(req.params.id);
          if (!root) {
            res.status(404).json({ error: "Taxonomy root not found" });
            return;
          }
          res.json(root);
        } catch (error) {
          next(error);
        }
      },
    });

    apiRoute(ctx.app, ctx.registry, {
      method: "patch",
      path: operation.path,
      tags: ["Taxonomies"],
      summary: `Update taxonomy${operation.element ? " element" : ""} metadata`,
      body: UpdateTaxonomyMetadataInputSchema,
      response: responseSchema,
      handler: async (req, res, next) => {
        try {
          if (!(await requireTaxonome(ctx, res))) return;
          const rootStore = operation.element
            ? ctx.taxonomyElementStore
            : ctx.taxonomyStore;
          const root = await rootStore.get(req.params.id);
          if (!root) {
            res.status(404).json({ error: "Taxonomy root not found" });
            return;
          }
          assertUserRoot(root);
          res.json(await rootStore.updateMetadata(req.params.id, req.body));
        } catch (error) {
          next(error);
        }
      },
    });

    apiRoute(ctx.app, ctx.registry, {
      method: "delete",
      path: operation.path,
      tags: ["Taxonomies"],
      summary: `Soft-delete a taxonomy${operation.element ? " element" : ""}`,
      response: z.any(),
      rawResponse: true,
      successStatus: 204,
      handler: async (req, res, next) => {
        try {
          if (!(await requireTaxonome(ctx, res))) return;
          const rootStore = operation.element
            ? ctx.taxonomyElementStore
            : ctx.taxonomyStore;
          if (!(await rootStore.softDelete(req.params.id))) {
            res.status(404).json({ error: "User taxonomy root not found" });
            return;
          }
          res.status(204).send();
        } catch (error) {
          next(error);
        }
      },
    });

    apiRoute(ctx.app, ctx.registry, {
      method: "post",
      path: `${operation.path}/restore`,
      tags: ["Taxonomies"],
      summary: `Restore a taxonomy${operation.element ? " element" : ""}`,
      response: responseSchema,
      handler: async (req, res, next) => {
        try {
          if (!(await requireTaxonome(ctx, res))) return;
          const rootStore = operation.element
            ? ctx.taxonomyElementStore
            : ctx.taxonomyStore;
          const restored = await rootStore.restore(req.params.id);
          if (!restored) {
            res.status(404).json({ error: "Deleted user taxonomy root not found" });
            return;
          }
          res.json(restored);
        } catch (error) {
          next(error);
        }
      },
    });
  }

  for (const operation of [
    { path: "/api/v1/taxonomies/:id/revisions", element: false },
    { path: "/api/v1/taxonomy-elements/:id/revisions", element: true },
  ] as const) {
    const bodySchema = operation.element
      ? CreateTaxonomyElementRevisionInputSchema
      : CreateTaxonomyRevisionInputSchema;
    const responseSchema = operation.element
      ? TaxonomyElementRevisionResponseSchema
      : TaxonomyRevisionResponseSchema;

    apiRoute(ctx.app, ctx.registry, {
      method: "get",
      path: operation.path,
      tags: ["Taxonomies"],
      summary: `List taxonomy${operation.element ? " element" : ""} revisions`,
      response: z.array(responseSchema),
      handler: async (req, res, next) => {
        try {
          if (!(await requireTaxonome(ctx, res))) return;
          const rootStore = operation.element
            ? ctx.taxonomyElementStore
            : ctx.taxonomyStore;
          const revisionStore = operation.element
            ? ctx.taxonomyElementRevisionStore
            : ctx.taxonomyRevisionStore;
          const root = await rootStore.get(req.params.id, true);
          if (!root) {
            res.status(404).json({ error: "Taxonomy root not found" });
            return;
          }
          res.json(await revisionStore.list(root._id));
        } catch (error) {
          next(error);
        }
      },
    });

    apiRoute(ctx.app, ctx.registry, {
      method: "post",
      path: operation.path,
      tags: ["Taxonomies"],
      summary: `Create taxonomy${operation.element ? " element" : ""} revision`,
      body: bodySchema,
      response: responseSchema,
      successStatus: 201,
      handler: async (req, res, next) => {
        try {
          if (!(await requireTaxonome(ctx, res))) return;
          const rootStore = operation.element
            ? ctx.taxonomyElementStore
            : ctx.taxonomyStore;
          const revisionStore = operation.element
            ? ctx.taxonomyElementRevisionStore
            : ctx.taxonomyRevisionStore;
          const root = await rootStore.get(req.params.id);
          if (!root) {
            res.status(404).json({ error: "Taxonomy root not found" });
            return;
          }
          assertUserRoot(root);
          if (req.body.content.id !== root.id) {
            res.status(400).json({ error: "Revision id must match root id" });
            return;
          }
          if (!operation.element) {
            const elementError = await validateResolvedTaxonomyElements(
              ctx,
              root.projectId,
              req.body.content as PortableTaxonomyDocument,
            );
            if (elementError) {
              res.status(400).json({ error: elementError });
              return;
            }
          }
          const result = await revisionStore.create(
            root._id,
            req.body.content as never,
            req.body.creator,
          );
          res.status(result.deduplicated ? 200 : 201).json(result.revision);
        } catch (error) {
          next(error);
        }
      },
    });
  }

  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/taxonomy-revisions/:revisionId",
    tags: ["Taxonomies"],
    summary: "Get an exact taxonomy revision",
    response: TaxonomyRevisionResponseSchema,
    handler: async (req, res, next) => {
      try {
        if (!(await requireTaxonome(ctx, res))) return;
        const revision = await ctx.taxonomyRevisionStore.get(
          req.params.revisionId,
        );
        if (!revision) {
          res.status(404).json({ error: "Taxonomy revision not found" });
          return;
        }
        res.json(revision);
      } catch (error) {
        next(error);
      }
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/taxonomy-element-revisions/:revisionId",
    tags: ["Taxonomies"],
    summary: "Get an exact taxonomy element revision",
    response: TaxonomyElementRevisionResponseSchema,
    handler: async (req, res, next) => {
      try {
        if (!(await requireTaxonome(ctx, res))) return;
        const revision = await ctx.taxonomyElementRevisionStore.get(
          req.params.revisionId,
        );
        if (!revision) {
          res.status(404).json({ error: "Taxonomy element revision not found" });
          return;
        }
        res.json(revision);
      } catch (error) {
        next(error);
      }
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/taxonomy-revisions/:revisionId/export",
    tags: ["Taxonomies"],
    summary: "Export an exact taxonomy revision as portable YAML",
    response: z.string(),
    rawResponse: true,
    handler: async (req, res, next) => {
      try {
        if (!(await requireTaxonome(ctx, res))) return;
        const revision = await ctx.taxonomyRevisionStore.get(
          req.params.revisionId,
        );
        if (!revision) {
          res.status(404).json({ error: "Taxonomy revision not found" });
          return;
        }
        res.type("application/yaml").send(
          stringifyYaml(portableTaxonomyRevision(revision)),
        );
      } catch (error) {
        next(error);
      }
    },
  });

  apiRoute(ctx.app, ctx.registry, {
    method: "post",
    path: "/api/v1/taxonomy-revisions/:revisionId/copy",
    tags: ["Taxonomies"],
    summary: "Copy an exact built-in revision to user revision 1",
    query: ProjectIdQuerySchema,
    body: CopyBuiltinTaxonomyRevisionInputSchema,
    response: TaxonomyResponseSchema,
    successStatus: 201,
    handler: async (req, res, next) => {
      try {
        if (!(await requireTaxonome(ctx, res))) return;
        const source = await ctx.taxonomyRevisionStore.get(req.params.revisionId);
        if (!source || source.sourceType !== "builtin") {
          res.status(404).json({ error: "Built-in taxonomy revision not found" });
          return;
        }
        if (source.projectId !== getQueryProjectId(req)) {
          res.status(400).json({ error: "Taxonomy revision project mismatch" });
          return;
        }
        const content = portableTaxonomyRevision(source);
        const id = req.body.id ?? `${source.id}-copy`;
        const root = await ctx.taxonomyStore.create({
          projectId: source.projectId,
          id,
          name: req.body.name,
          ...(req.body.description
            ? { description: req.body.description }
            : {}),
          sourceType: "user",
          ...(req.body.creator ? { creator: req.body.creator } : {}),
        });
        await ctx.taxonomyRevisionStore.create(
          root._id,
          { ...content, id },
          req.body.creator,
        );
        res.status(201).json((await ctx.taxonomyStore.get(root._id)) ?? root);
      } catch (error) {
        next(error);
      }
    },
  });
}
