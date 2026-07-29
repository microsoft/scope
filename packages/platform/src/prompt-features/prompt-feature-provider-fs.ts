// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import type { PromptFeatureConfig } from '@scope/core';
import { PromptFeatureProvider } from './prompt-feature-provider.js';

/**
 * PromptFeatureProvider backed by YAML files on the filesystem.
 *
 * Loads all prompt features eagerly on construction and serves from an in-memory Map.
 */
export class FileSystemPromptFeatureProvider implements PromptFeatureProvider {
  private registry: Map<string, PromptFeatureConfig>;

  constructor(promptFeaturesDir: string) {
    this.registry = new Map();

    if (!existsSync(promptFeaturesDir)) {
      console.warn(`[FileSystemPromptFeatureProvider] Directory does not exist: ${promptFeaturesDir}`);
      return;
    }

    this.loadAll(promptFeaturesDir);
  }

  private loadAll(dir: string): void {
    const files = readdirSync(dir).filter(f =>
      f.endsWith('.yaml') || f.endsWith('.yml')
    );

    for (const file of files) {
      try {
        const filePath = join(dir, file);
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

        const feature: PromptFeatureConfig = {
          id: data.id.trim(),
          prompt: data.prompt.trim(),
        };

        if (this.registry.has(feature.id)) {
          throw new Error(`Duplicate prompt feature id '${feature.id}' found in ${file}`);
        }

        this.registry.set(feature.id, feature);
      } catch (error) {
        throw new Error(
          `Failed to load prompt feature from ${file}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    console.log(`[FileSystemPromptFeatureProvider] Loaded ${this.registry.size} prompt features from ${dir}`);
  }

  async get(id: string): Promise<PromptFeatureConfig | undefined> {
    return this.registry.get(id);
  }

  async getAll(): Promise<PromptFeatureConfig[]> {
    return Array.from(this.registry.values());
  }

  async has(id: string): Promise<boolean> {
    return this.registry.has(id);
  }

  async size(): Promise<number> {
    return this.registry.size;
  }
}
