// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { visit } from 'unist-util-visit';

export default function remarkBasePath({ base = '/' } = {}) {
	const prefix = `/${base.replace(/^\/+|\/+$/g, '')}`;

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
