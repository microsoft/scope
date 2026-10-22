// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { CriteriaConfig } from '../types/types.js';
import { CriteriaProvider } from './criteria-provider.js';

/**
 * CriteriaProvider backed by YAML files on the filesystem.
 *
 * Loads all criteria eagerly on construction and serves from an in-memory Map.
 * Reads YAML files from a directory, supporting both `depends_on` (snake_case)
 * and `dependsOn` (camelCase) formats.
 */
export class FileSystemCriteriaProvider implements CriteriaProvider {
  private registry: Map<string, CriteriaConfig>;

  constructor(criteriaDir: string) {
    this.registry = new Map();

    if (!existsSync(criteriaDir)) {
      console.warn(`[FileSystemCriteriaProvider] Criteria directory does not exist: ${criteriaDir}`);
      return;
    }

    this.loadAllCriteria(criteriaDir);
  }

  private loadAllCriteria(criteriaDir: string): void {
    const files = readdirSync(criteriaDir).filter(f =>
      f.endsWith('.yaml') || f.endsWith('.yml')
    );

    for (const file of files) {
      try {
        const filePath = join(criteriaDir, file);
        const content = readFileSync(filePath, 'utf-8');
        const data = parseYaml(content);

        if (!data || typeof data !== 'object') {
          throw new Error(`Invalid YAML content in ${file}`);
        }
        if (!data.id || typeof data.id !== 'string') {
          throw new Error(`Missing or invalid 'id' field in ${file}`);
        }
        if (!data.prompt || typeof data.prompt !== 'string') {
          throw new Error(`Missing or invalid 'prompt' field in ${file}`);
        }

        const dependsOn = data.depends_on || data.dependsOn || [];
        if (!Array.isArray(dependsOn)) {
          throw new Error(`'depends_on'/'dependsOn' must be an array in ${file}`);
        }

        const criteria: CriteriaConfig = {
          id: data.id.trim(),
          prompt: data.prompt.trim(),
          dependsOn: dependsOn.map((d: any) => String(d).trim()),
        };

        const gates = data.gates;
        if (gates !== undefined) {
          if (!Array.isArray(gates)) {
            throw new Error(`'gates' must be an array in ${file}`);
          }
          criteria.gates = gates.map((g: any) => String(g).trim()) as CriteriaConfig["gates"];
        }

        const kind = data.kind;
        if (kind !== undefined) {
          if (kind !== "gate" && kind !== "observation") {
            throw new Error(`'kind' must be 'gate' or 'observation' in ${file}`);
          }
          criteria.kind = kind;
        }

        const taxonomyElementId = data.taxonomy_element_id || data.taxonomyElementId;
        if (taxonomyElementId !== undefined) {
          criteria.taxonomyElementId = String(taxonomyElementId).trim() as CriteriaConfig["taxonomyElementId"];
        }

        const subject = data.subject;
        if (subject !== undefined) {
          if (subject !== "run" && subject !== "iteration") {
            throw new Error(`'subject' must be 'run' or 'iteration' in ${file}`);
          }
          criteria.subject = subject;
        }

        if (this.registry.has(criteria.id)) {
          throw new Error(`Duplicate criteria id '${criteria.id}' found in ${file}`);
        }

        this.registry.set(criteria.id, criteria);
      } catch (error) {
        throw new Error(
          `Failed to load criteria from ${file}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    console.log(`[FileSystemCriteriaProvider] Loaded ${this.registry.size} criteria from ${criteriaDir}`);
  }

  async get(id: string): Promise<CriteriaConfig | undefined> {
    return this.registry.get(id);
  }

  async getAll(): Promise<CriteriaConfig[]> {
    return Array.from(this.registry.values());
  }

  async resolveWithAncestors(ids: string[]): Promise<CriteriaConfig[]> {
    const collected = new Map<string, CriteriaConfig>();
    const queue = [...ids];

    while (queue.length > 0) {
      const id = queue.shift()!;
      if (collected.has(id)) continue;

      const criteria = this.registry.get(id);
      if (!criteria) {
        const availableIds = Array.from(this.registry.keys()).join(', ');
        throw new Error(
          `Criteria '${id}' not found in registry. Available criteria: ${availableIds || 'none'}`
        );
      }
      collected.set(id, criteria);

      if (criteria.dependsOn) {
        for (const parentId of criteria.dependsOn) {
          if (!collected.has(parentId)) {
            queue.push(parentId);
          }
        }
      }
    }

    return Array.from(collected.values());
  }

  async has(id: string): Promise<boolean> {
    return this.registry.has(id);
  }

  async size(): Promise<number> {
    return this.registry.size;
  }
}
