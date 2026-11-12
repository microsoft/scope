// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import YAML from 'yaml';
import { loadTaxonomeCatalog } from './taxonome-catalog.mjs';

const element = {
	id: 'example',
	label: 'Example <script>not executable</script>',
	implementation: { type: 'prompt', prompt: 'Assess the recorded evidence.' },
	output: { evidence_roles: { step: { type: 'atif.step', description: 'Exact step.' } } },
};

async function fixture(t, entries = [{ path: 'elements/example.yaml' }]) {
	const root = await mkdtemp(join(tmpdir(), 'taxonome-docs-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, 'elements'));
	const manifest = join(root, 'taxonomy.yaml');
	const value = {
		schema_version: 'scope/taxonomy/v1', id: 'example', version: '1.0.0',
		surfaces: [], elements: entries,
	};
	await writeFile(manifest, YAML.stringify(value, { aliasDuplicateObjects: false }));
	await writeFile(join(root, 'elements/example.yaml'), YAML.stringify(element));
	return { root, manifest, value };
}

test('canonical catalog preserves Ax identity, order, references and full source', async () => {
	const loaded = await loadTaxonomeCatalog();
	const manifest = new URL('../../../packages/ax-taxonomy/taxonomy/taxonomy.yaml', import.meta.url);
	const raw = await readFile(manifest, 'utf8');
	const document = YAML.parse(raw);
	assert.equal(loaded.source, raw);
	assert.equal(loaded.id, 'ax-taxonomy');
	assert.equal(loaded.version, '1.0.0');
	assert.equal(loaded.id, document.id);
	assert.equal(loaded.version, document.version);
	assert.deepEqual(loaded.elements.map(item => item.file), document.elements.map(item => item.path));
	assert.deepEqual(
		loaded.elements.map(item => item.id),
		[
			'beh-discovered',
			'beh-skipped-invocation',
			'beh-wrong-discovery',
			'beh-content-misused',
			'beh-malformed-invocation',
			'beh-timeout',
		],
	);
	for (const item of loaded.elements) {
		const source = await readFile(new URL(item.file, manifest), 'utf8');
		const authored = YAML.parse(source);
		assert.equal(item.source, source);
		assert.equal(item.id, authored.id);
		assert.equal(item.label, authored.label);
		assert.equal(item.type, authored.implementation.type);
	}
	assert.equal(loaded.elements.filter(item => item.type === 'prompt').length, 3);
	assert.equal(loaded.elements.filter(item => item.type === 'deterministic').length, 3);
});

test('inline display does not require resolving or executing a handler', async t => {
	const custom = { ...element, implementation: { type: 'deterministic', handler: 'unknown/not-loaded' } };
	const f = await fixture(t, [custom]);
	const loaded = await loadTaxonomeCatalog(f.manifest);
	assert.equal(loaded.elements[0].detail, 'unknown/not-loaded');
	assert.equal(loaded.elements[0].file, 'inline element 1');
	assert.equal(loaded.elements[0].label, element.label);
});

test('rejects duplicate IDs, references and surface IDs', async t => {
	for (const entries of [[element, element], [{ path: 'elements/example.yaml' }, { path: 'elements/example.yaml' }]]) {
		const f = await fixture(t, entries);
		await assert.rejects(loadTaxonomeCatalog(f.manifest), /Duplicate/);
	}
	const f = await fixture(t);
	f.value.surfaces = [{ id: 'one', label: 'One' }, { id: 'one', label: 'Two' }];
	await writeFile(f.manifest, YAML.stringify(f.value));
	await assert.rejects(loadTaxonomeCatalog(f.manifest), /Duplicate/);
});

test('rejects missing references, traversal, absolute paths and symlinks', async t => {
	for (const path of ['missing.yaml', '../outside.yaml', '/outside.yaml', 'elements\\example.yaml']) {
		const f = await fixture(t, [{ path }]);
		await assert.rejects(loadTaxonomeCatalog(f.manifest));
	}
	const f = await fixture(t, [{ path: 'alias.yaml' }]);
	await symlink(join(f.root, 'elements/example.yaml'), join(f.root, 'alias.yaml'));
	await assert.rejects(loadTaxonomeCatalog(f.manifest), /symlink/);
	await symlink(f.manifest, join(f.root, 'manifest-link.yaml'));
	await assert.rejects(loadTaxonomeCatalog(join(f.root, 'manifest-link.yaml')), /symlink/);
});

test('rejects malformed, duplicate-key, anchored and aliased YAML', async t => {
	for (const source of ['[broken', 'id: one\nid: two\n', 'id: &id one\nlabel: *id\n']) {
		const f = await fixture(t);
		await writeFile(f.manifest, source);
		await assert.rejects(loadTaxonomeCatalog(f.manifest), /YAML/);
	}
});

test('fails invalid display fields instead of rendering an empty success', async t => {
	for (const invalid of [
		{ ...element, id: '<unsafe>' },
		{ ...element, label: '' },
		{ ...element, implementation: { type: 'execute', path: './code.js' } },
		{ ...element, output: { evidence_roles: {} } },
		{ ...element, preconditions: { requires_task: 'true' } },
		{ ...element, output: { evidence_roles: { step: { type: 'atif.step', description: 'Step', min: 2, max: 1 } } } },
	]) {
		const f = await fixture(t, [invalid]);
		await assert.rejects(loadTaxonomeCatalog(f.manifest));
	}
	const f = await fixture(t);
	f.value.schema_version = 'unknown';
	await writeFile(f.manifest, YAML.stringify(f.value));
	await assert.rejects(loadTaxonomeCatalog(f.manifest), /version/);
});

test('bounds file bytes, aggregate bytes and reference count', async t => {
	const oversized = await fixture(t);
	await writeFile(oversized.manifest, 'x'.repeat(1024 * 1024 + 1));
	await assert.rejects(loadTaxonomeCatalog(oversized.manifest), /byte limit/);
	const many = await fixture(t, Array.from({ length: 101 }, (_, index) => ({ path: `elements/${index}.yaml` })));
	for (let index = 0; index < 101; index++) {
		await writeFile(join(many.root, `elements/${index}.yaml`), YAML.stringify({ ...element, id: `e${index}` }));
	}
	await assert.rejects(loadTaxonomeCatalog(many.manifest), /reference count/);
	const aggregate = await fixture(t, Array.from({ length: 5 }, (_, index) => ({ path: `elements/${index}.yaml` })));
	for (let index = 0; index < 5; index++) {
		await writeFile(join(aggregate.root, `elements/${index}.yaml`),
			YAML.stringify({ ...element, id: `e${index}`, description: 'a'.repeat(900_000) }));
	}
	await assert.rejects(loadTaxonomeCatalog(aggregate.manifest), /byte limit/);
});

test('docs loader has no runtime, network or executable handler import', async () => {
	const source = await readFile(new URL('./taxonome-catalog.mjs', import.meta.url), 'utf8');
	assert.doesNotMatch(source, /(?:from|import\s*\()\s*['"](?:taxonomy-engine|ax-taxonomy|@ax-llm|@github\/copilot)/);
	assert.doesNotMatch(source, /\bfetch\s*\(|\beval\s*\(|new Function/);
});
