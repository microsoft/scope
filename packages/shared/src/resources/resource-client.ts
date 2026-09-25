// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type {
  ResourceConfig,
  ResourceDocument,
  ResourceRevisionDocument,
} from "../types/resource.js";

/**
 * Client for resolving resource specs via the Scope REST API.
 *
 * Used by queue processors at message-processing time to turn the specs stored
 * on a RequestDocument into the `ResourceConfig` objects a worker needs in order
 * to run the lifecycle phases.
 *
 * A spec is one of:
 * - `"github-simulator"` — the resource's latest revision at resolution time
 * - `"github-simulator@r2"` — an explicit revision
 * - a revision id
 *
 * Mirrors how a codebase spec is resolved. Note that the *request* should store
 * the resolved revision id rather than the spec, so a run stays explainable after
 * the resource moves on; this client is what produces that resolution.
 */
export class ResourceClient {
  private readonly apiUrl: string;

  constructor(apiUrl: string) {
    this.apiUrl = apiUrl.replace(/\/+$/, "");
  }

  private async getJson<T>(path: string, projectId: string): Promise<T | null> {
    const sep = path.includes("?") ? "&" : "?";
    const url = `${this.apiUrl}${path}${sep}projectId=${encodeURIComponent(projectId)}`;
    const res = await fetch(url);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`[ResourceClient] GET ${url} failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }

  /**
   * Resolve one spec to a concrete revision.
   *
   * @throws Error if the resource or revision does not exist. A missing resource
   * must fail the run rather than silently producing an environment without it.
   */
  async resolveResource(projectId: string, spec: string): Promise<ResourceConfig> {
    const trimmed = spec.trim();
    if (trimmed === "") throw new Error("[ResourceClient] empty resource spec");

    const at = trimmed.lastIndexOf("@r");
    const slug = at > 0 ? trimmed.slice(0, at) : trimmed;
    const revisionNumber = at > 0 ? Number(trimmed.slice(at + 2)) : undefined;

    if (at > 0 && (!Number.isInteger(revisionNumber) || revisionNumber! < 1)) {
      throw new Error(`[ResourceClient] invalid revision in resource spec '${spec}'`);
    }

    // A bare spec may be a slug or a revision id; try the revision id first only
    // when it cannot be a slug@rN form.
    const revision =
      revisionNumber !== undefined
        ? await this.getJson<ResourceRevisionDocument>(
            `/api/v1/resources/${encodeURIComponent(slug)}/revisions/${revisionNumber}`,
            projectId,
          )
        : ((await this.getJson<ResourceRevisionDocument>(
            `/api/v1/resources/revisions/${encodeURIComponent(trimmed)}`,
            projectId,
          )) ??
          (await this.getJson<ResourceRevisionDocument>(
            `/api/v1/resources/${encodeURIComponent(trimmed)}/revisions/latest`,
            projectId,
          )));

    if (!revision) {
      throw new Error(`[ResourceClient] resource '${spec}' not found via API`);
    }

    const resource = await this.getJson<ResourceDocument>(
      `/api/v1/resources/${encodeURIComponent(revision.resourceId)}`,
      projectId,
    );

    return {
      ref: revision.ref,
      resourceId: revision.resourceId,
      revisionId: revision._id,
      slug: revision.slug,
      name: resource?.name ?? revision.slug,
      setup: revision.setup,
      ...(revision.teardown ? { teardown: revision.teardown } : {}),
      exports: revision.exports ?? [],
    };
  }

  /** Resolve every spec, in order. Order is preserved because it determines setup order. */
  async resolveResources(projectId: string, specs: string[]): Promise<ResourceConfig[]> {
    const configs: ResourceConfig[] = [];
    for (const spec of specs) {
      configs.push(await this.resolveResource(projectId, spec));
    }
    return configs;
  }
}
