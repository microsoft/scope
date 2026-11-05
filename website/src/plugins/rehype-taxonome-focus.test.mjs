// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import plugin from './rehype-taxonome-focus.mjs';

test('makes Taxonome code and tables focusable without replacing existing attributes', () => {
	const tree = { type: 'root', children: [
		{ type: 'element', tagName: 'pre', properties: {}, children: [] },
		{ type: 'element', tagName: 'table', properties: { tabIndex: 2 }, children: [] },
	] };
	plugin()(tree, { path: '/website/src/content/docs/guides/taxonome.md' });
	assert.equal(tree.children[0].properties.tabIndex, 0);
	assert.equal(tree.children[1].properties.tabIndex, 2);
});

test('leaves unrelated pages unchanged and is idempotent', () => {
	const tree = { type: 'root', children: [
		{ type: 'element', tagName: 'pre', properties: {}, children: [] },
	] };
	const original = structuredClone(tree);
	plugin()(tree, { path: '/docs/guides/another-page.md' });
	assert.deepEqual(tree, original);
	plugin()(tree, { path: '/docs/reference/taxonome-cli.mdx' });
	const once = structuredClone(tree);
	plugin()(tree, { path: '/docs/reference/taxonome-cli.mdx' });
	assert.deepEqual(tree, once);
});
