// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { visit } from 'unist-util-visit';

const SLASH = 0x2f;

// Linear-time trim of leading/trailing `/`; the equivalent alternation regex
// backtracks polynomially on a long run of `/` that is not at the end.
function trimSlashes(value) {
	let start = 0;
	let end = value.length;
	while (start < end && value.charCodeAt(start) === SLASH) start++;
	while (end > start && value.charCodeAt(end - 1) === SLASH) end--;
	return value.slice(start, end);
}

export default function remarkBasePath({ base = '/' } = {}) {
	const prefix = `/${trimSlashes(base)}`;

	function withBase(url) {
		if (!url.startsWith('/') || url.startsWith('//')) return url;
		const pathname = url.split(/[?#]/, 1)[0];
		if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return url;
		return `${prefix}${url}`;
	}

	return function transformer(tree) {
		if (prefix === '/') return;

		visit(tree, (node) => {
			if (node.type === 'link' || node.type === 'image' || node.type === 'definition') {
				node.url = withBase(node.url);
			}

			// MDX anchors and images keep literal attributes outside Markdown link nodes.
			if (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') {
				for (const attribute of node.attributes) {
					if (
						attribute.type === 'mdxJsxAttribute' &&
						(attribute.name === 'href' || attribute.name === 'src') &&
						typeof attribute.value === 'string'
					) {
						attribute.value = withBase(attribute.value);
					}
				}
			}
		});
	};
}
