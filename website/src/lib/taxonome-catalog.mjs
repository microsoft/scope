// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAlias, parseDocument, visit } from 'yaml';

export const documentationSourceRoot = typeof __SCOPE_DOCS_SOURCE_ROOT__ === 'string'
	? __SCOPE_DOCS_SOURCE_ROOT__
	: fileURLToPath(new URL('../../../', import.meta.url));
const REPO = documentationSourceRoot;
const MANIFEST = resolve(REPO, 'packages/ax-taxonomy/taxonomy/taxonomy.yaml');
const VERSION = 'scope/taxonomy/v1';
const FLAGS = [
	'requires_complete_trajectory',
	'requires_task',
	'requires_recorded_discovery',
];

function object(value, location) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`${location} must be an object`);
	}
	return value;
}

function text(value, location) {
	if (typeof value !== 'string' || !value.trim()) {
		throw new Error(`${location} must be a nonempty string`);
	}
	return value;
}

function identifier(value, location) {
	const id = text(value, location);
	if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
		throw new Error(`${location} is not a valid identifier`);
	}
	return id;
}

/** Read bounded YAML as data only; never resolve or execute a handler. */
async function yamlFile(path, budget) {
	const info = await lstat(path);
	if (!info.isFile() || info.isSymbolicLink()) {
		throw new Error(`Catalog source must be a regular non-symlink file: ${path}`);
	}
	budget.bytes += info.size;
	if (info.size > 1024 * 1024 || budget.bytes > 4 * 1024 * 1024) {
		throw new Error('Catalog YAML exceeds its file or aggregate byte limit');
	}
	const source = await readFile(path, 'utf8');
	const document = parseDocument(source, { uniqueKeys: true, strict: true });
	if (document.errors.length || document.warnings.length) {
		throw new Error(`Invalid catalog YAML: ${path}`);
	}
	visit(document, (_key, node) => {
		if (isAlias(node) || (node && typeof node === 'object' && node.anchor)) {
			throw new Error('Catalog YAML cannot contain aliases or anchors');
		}
	});
	return { value: document.toJS({ maxAliasCount: 0 }), source };
}

/** Resolve authored paths beneath the manifest, excluding symlink traversal. */
async function elementPath(root, path) {
	text(path, 'Element reference path');
	if (isAbsolute(path) || path.includes('\\') || path.split('/').includes('..')) {
		throw new Error(`Unsafe catalog reference: ${path}`);
	}
	const candidate = resolve(root, path);
	const outside = relative(root, candidate);
	if (!outside || outside.startsWith(`..${sep}`) || isAbsolute(outside)) {
		throw new Error(`Catalog reference escapes its root: ${path}`);
	}
	let cursor = root;
	for (const segment of outside.split(sep)) {
		cursor = resolve(cursor, segment);
		if ((await lstat(cursor)).isSymbolicLink()) {
			throw new Error(`Catalog reference cannot traverse a symlink: ${path}`);
		}
	}
	return realpath(candidate);
}

/** Validate only the display projection; runtime schemas remain authoritative. */
function displayElement(raw, file, source) {
	const value = object(raw, 'Element');
	if (value.schema_version !== undefined && value.schema_version !== VERSION) {
		throw new Error('Unsupported element schema version');
	}
	const id = identifier(value.id, 'Element ID');
	const implementation = object(value.implementation, `${id} implementation`);
	if (!['prompt', 'deterministic'].includes(implementation.type)) {
		throw new Error(`${id} has an unsupported implementation type`);
	}
	const detail = implementation.type === 'prompt'
		? text(implementation.prompt, `${id} prompt`)
		: text(implementation.handler, `${id} handler`);
	const output = object(value.output, `${id} output`);
	const roles = Object.entries(object(output.evidence_roles, `${id} evidence roles`));
	if (!roles.length) throw new Error(`${id} must declare evidence roles`);
	const evidence = roles.map(([name, rawRole]) => {
		const role = object(rawRole, `${id}/${name}`);
		const min = role.min ?? 1;
		if (!Number.isInteger(min) || min < 0 ||
			(role.max !== undefined && (!Number.isInteger(role.max) || role.max < min))) {
			throw new Error(`${id}/${name} has invalid evidence cardinality`);
		}
		return {
			name,
			type: text(role.type, `${id}/${name} type`),
			description: text(role.description, `${id}/${name} description`),
			min,
			max: role.max,
		};
	});
	const preconditions = object(value.preconditions ?? {}, `${id} preconditions`);
	for (const [name, enabled] of Object.entries(preconditions)) {
		if (!FLAGS.includes(name) || typeof enabled !== 'boolean') {
			throw new Error(`${id} has invalid display preconditions`);
		}
	}
	return {
		id,
		label: text(value.label, `${id} label`),
		description: value.description === undefined ? '' : text(value.description, `${id} description`),
		type: implementation.type,
		detail,
		file,
		source,
		evidence,
		preconditions: FLAGS.map(name => ({ name, enabled: preconditions[name] ?? false })),
	};
}

/** Build the static catalog from canonical YAML without importing runtime packages. */
export async function loadTaxonomeCatalog(manifest = MANIFEST) {
	if ((await lstat(manifest)).isSymbolicLink()) throw new Error('Catalog manifest cannot be a symlink');
	const path = await realpath(manifest);
	const root = dirname(path);
	const budget = { bytes: 0 };
	const { value: raw, source } = await yamlFile(path, budget);
	const value = object(raw, 'Taxonomy');
	if (value.schema_version !== VERSION) throw new Error('Unsupported taxonomy schema version');
	const id = identifier(value.id, 'Taxonomy ID');
	const version = text(value.version, 'Taxonomy version');
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
		throw new Error('Invalid taxonomy semantic version');
	}
	if (!Array.isArray(value.surfaces) || value.surfaces.length > 100) {
		throw new Error('Taxonomy surfaces must be an array of at most 100 entries');
	}
	const surfaces = value.surfaces.map(surface => ({
		id: identifier(object(surface, 'Surface').id, 'Surface ID'),
		label: text(surface.label, 'Surface label'),
	}));
	if (new Set(surfaces.map(surface => surface.id)).size !== surfaces.length) {
		throw new Error('Duplicate taxonomy surface ID');
	}
	if (!Array.isArray(value.elements) || !value.elements.length || value.elements.length > 200) {
		throw new Error('Catalog must contain 1-200 elements');
	}
	const seen = new Set();
	const elements = [];
	for (const entry of value.elements) {
		const record = object(entry, 'Element entry');
		if ('path' in record) {
			if (Object.keys(record).length !== 1) throw new Error('Invalid element reference fields');
			if (seen.size >= 100) throw new Error('Catalog reference count exceeds 100');
			const target = await elementPath(root, record.path);
			if (seen.has(target)) throw new Error('Duplicate catalog reference');
			seen.add(target);
			const loaded = await yamlFile(target, budget);
			elements.push(displayElement(loaded.value, record.path, loaded.source));
		} else {
			// Inline definitions have no separate source file; preserve the manifest verbatim.
			elements.push(displayElement(entry, `inline element ${elements.length + 1}`, source));
		}
	}
	if (new Set(elements.map(element => element.id)).size !== elements.length) {
		throw new Error('Duplicate catalog element ID');
	}
	const relativeFile = relative(REPO, path);
	return {
		id, version, source, surfaces, elements,
		file: relativeFile.startsWith('..') ? basename(path) : relativeFile,
	};
}
