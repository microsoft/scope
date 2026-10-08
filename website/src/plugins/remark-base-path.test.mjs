// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import remarkBasePath from './remark-base-path.mjs';

function transform(children, base = '/scope') {
	const tree = { type: 'root', children };
	remarkBasePath({ base })(tree);
	return tree;
}

test('prefixes Markdown links, images, and reference definitions', () => {
	const tree = transform([
		{ type: 'link', url: '/getting-started/access/', children: [] },
		{ type: 'image', url: '/images/scope.svg', alt: 'Scope' },
		{ type: 'definition', identifier: 'api', url: '/reference/api/?view=full#requests' },
		{ type: 'link', url: '/', children: [] },
	]);

	assert.deepEqual(tree.children.map((node) => node.url), [
		'/scope/getting-started/access/',
		'/scope/images/scope.svg',
		'/scope/reference/api/?view=full#requests',
		'/scope/',
	]);
});

test('prefixes literal MDX href and src attributes, including nested links', () => {
	const tree = transform([
		{
			type: 'mdxJsxFlowElement',
			name: 'section',
			attributes: [],
			children: [
				{
					type: 'mdxJsxTextElement',
					name: 'a',
					attributes: [{ type: 'mdxJsxAttribute', name: 'href', value: '/guides/defining-criteria/' }],
					children: [],
				},
				{
					type: 'mdxJsxFlowElement',
					name: 'img',
					attributes: [{ type: 'mdxJsxAttribute', name: 'src', value: '/images/scope.svg' }],
					children: [],
				},
			],
		},
	]);

	assert.equal(tree.children[0].children[0].attributes[0].value, '/scope/guides/defining-criteria/');
	assert.equal(tree.children[0].children[1].attributes[0].value, '/scope/images/scope.svg');
});

test('leaves external, relative, fragment, and already-prefixed URLs unchanged', () => {
	const urls = [
		'https://example.com/reference/',
		'//example.com/reference/',
		'mailto:docs@example.com',
		'../reference/',
		'#requests',
		'?view=full',
		'',
		'/scope',
		'/scope/',
		'/scope?view=full',
		'/scope#requests',
		'/scope/reference/api/',
	];
	const tree = transform(urls.map((url) => ({ type: 'link', url, children: [] })));

	assert.deepEqual(tree.children.map((node) => node.url), urls);
});

test('does not mistake a similar path for the configured base', () => {
	const tree = transform([{ type: 'link', url: '/scope-other/', children: [] }]);
	assert.equal(tree.children[0].url, '/scope/scope-other/');
});

test('preserves code examples, MDX expressions, spreads, and unrelated attributes', () => {
	const children = [
		{ type: 'code', lang: 'http', value: 'GET /api/v1/requests' },
		{ type: 'inlineCode', value: '/api/v1/requests' },
		{
			type: 'mdxJsxTextElement',
			name: 'a',
			attributes: [
				{ type: 'mdxJsxAttribute', name: 'href', value: { type: 'mdxJsxAttributeValueExpression', value: 'url' } },
				{ type: 'mdxJsxExpressionAttribute', value: '...props' },
				{ type: 'mdxJsxAttribute', name: 'title', value: '/reference/' },
				{ type: 'mdxJsxAttribute', name: 'download', value: null },
			],
			children: [],
		},
	];
	const original = structuredClone(children);
	transform(children);

	assert.deepEqual(children, original);
});

test('normalizes base paths and only prefixes URLs once', () => {
	for (const base of ['/scope', '/scope/', 'scope', '/nested/scope/']) {
		const tree = transform([{ type: 'link', url: '/reference/api/', children: [] }], base);
		remarkBasePath({ base })(tree);
		const prefix = base.includes('nested') ? '/nested/scope' : '/scope';
		assert.equal(tree.children[0].url, `${prefix}/reference/api/`);
	}
});

test('leaves root deployments unchanged', () => {
	for (const base of ['/', '']) {
		const children = [{ type: 'link', url: '/reference/api/', children: [] }];
		const original = structuredClone(children);
		transform(children, base);
		assert.deepEqual(children, original);
	}
	const tree = { type: 'root', children: [{ type: 'link', url: '/reference/api/', children: [] }] };
	remarkBasePath()(tree);
	assert.equal(tree.children[0].url, '/reference/api/');
});
