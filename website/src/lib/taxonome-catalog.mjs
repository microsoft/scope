// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { access, lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { isAlias, parseDocument, visit } from 'yaml';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_ELEMENTS = 100;
async function canonicalManifestPath() {
	for (const candidate of [
		resolve(process.cwd(), 'packages/ax-taxonomy/taxonomy/taxonomy.yaml'),
		resolve(process.cwd(), '../packages/ax-taxonomy/taxonomy/taxonomy.yaml'),
	]) {
		try {
			await access(candidate);
			return candidate;
		} catch {
			// Try the next supported repository/website working directory.
		}
	}
	throw new Error('Cannot locate canonical Ax taxonomy manifest');
}

async function safeYaml(path, root) {
	const unresolved = resolve(path);
	if ((await lstat(unresolved)).isSymbolicLink()) {
		throw new Error(`Taxonome documentation source cannot be a symlink: ${path}`);
	}
	const actual = await realpath(unresolved);
	const rel = relative(root, actual);
	if (rel === '..' || rel.startsWith(`..${sep}`)) {
		throw new Error(`Taxonome documentation source escapes its root: ${path}`);
	}
	const source = await readFile(actual, 'utf8');
	if (Buffer.byteLength(source) > MAX_FILE_BYTES) {
		throw new Error(`Taxonome documentation source exceeds ${MAX_FILE_BYTES} bytes`);
	}
	const document = parseDocument(source, { uniqueKeys: true });
	visit(document, {
		Node(_key, node) {
			if (isAlias(node)) throw new Error('YAML aliases are not supported');
		},
	});
	if (document.errors.length) throw document.errors[0];
	return { source, value: document.toJS(), path: actual };
}

/** Loads the canonical catalog without importing or executing the engine. */
export async function loadTaxonomeCatalog(path) {
	path ??= await canonicalManifestPath();
	const manifestActual = await realpath(path);
	const root = dirname(manifestActual);
	const manifest = await safeYaml(manifestActual, root);
	if (
		manifest.value?.schema_version !== 'scope/taxonomy/v1' ||
		typeof manifest.value.id !== 'string' ||
		typeof manifest.value.version !== 'string' ||
		!Array.isArray(manifest.value.elements)
	) {
		throw new Error('Invalid canonical Taxonome manifest');
	}
	if (manifest.value.elements.length > MAX_ELEMENTS) {
		throw new Error(`Taxonome manifest exceeds ${MAX_ELEMENTS} elements`);
	}
	const seenPaths = new Set();
	const seenIds = new Set();
	const elements = [];
	for (const reference of manifest.value.elements) {
		if (!reference || typeof reference !== 'object' || typeof reference.path !== 'string') {
			throw new Error('Canonical Taxonome documentation requires path references');
		}
		if (seenPaths.has(reference.path)) {
			throw new Error(`Duplicate element reference '${reference.path}'`);
		}
		seenPaths.add(reference.path);
		const loaded = await safeYaml(resolve(root, reference.path), root);
		if (typeof loaded.value?.id !== 'string' || typeof loaded.value?.label !== 'string') {
			throw new Error(`Invalid Taxonome element '${reference.path}'`);
		}
		if (seenIds.has(loaded.value.id)) {
			throw new Error(`Duplicate element ID '${loaded.value.id}'`);
		}
		seenIds.add(loaded.value.id);
		elements.push({
			...loaded.value,
			path: reference.path,
			source: loaded.source,
		});
	}
	return {
		...manifest.value,
		source: manifest.source,
		elements,
	};
}
