// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  PortableTaxonomyElementSchema,
  PortableTaxonomySchema,
} from "shared";
import type { RouteContext } from "./route-context.js";

const CATALOG_DIRECTORY = fileURLToPath(
  new URL("../../../packages/ax-taxonomy/taxonomy/", import.meta.url),
);

/** Idempotently seeds the canonical built-in taxonomy into one project. */
export async function ensureBuiltinTaxonomy(
  ctx: RouteContext,
  projectId: string,
  catalogDirectory = CATALOG_DIRECTORY,
): Promise<void> {
  const taxonomyPath = resolve(catalogDirectory, "taxonomy.yaml");
  const taxonomy = PortableTaxonomySchema.parse(
    parseYaml(await readFile(taxonomyPath, "utf8")),
  );
  const existing = await ctx.taxonomyStore.getByBusinessId(
    projectId,
    taxonomy.id,
    true,
  );
  if (existing) return;

  const elementRefs: Array<{ ref: string }> = [];
  for (const reference of taxonomy.elements) {
    if (!("path" in reference)) {
      throw new Error("Canonical built-in taxonomy must use local element paths");
    }
    const element = PortableTaxonomyElementSchema.parse(
      parseYaml(
        await readFile(resolve(dirname(taxonomyPath), reference.path), "utf8"),
      ),
    );
    const existingElement = await ctx.taxonomyElementStore.getByBusinessId(
      projectId,
      element.id,
      true,
    );
    const root =
      existingElement ??
      (await ctx.taxonomyElementStore.create({
        projectId,
        id: element.id,
        name: element.label,
        ...(element.description ? { description: element.description } : {}),
        sourceType: "builtin",
        creator: "system",
      }));
    const revision = existingElement
      ? {
          revision: await ctx.taxonomyElementRevisionStore.getLatest(root._id),
          deduplicated: true,
        }
      : await ctx.taxonomyElementRevisionStore.create(
          root._id,
          element,
          "system",
        );
    if (!revision.revision) {
      throw new Error(`Built-in element '${element.id}' has no revision`);
    }
    elementRefs.push({ ref: revision.revision.ref });
  }

  const root = await ctx.taxonomyStore.create({
    projectId,
    id: taxonomy.id,
    name: taxonomy.id,
    description: `${taxonomy.id} ${taxonomy.version}`,
    sourceType: "builtin",
    creator: "system",
  });
  await ctx.taxonomyRevisionStore.create(
    root._id,
    { ...taxonomy, elements: elementRefs },
    "system",
  );
}
