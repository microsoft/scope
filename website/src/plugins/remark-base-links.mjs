// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { visit } from 'unist-util-visit';

/** Keep authored root-relative documentation links under the Pages project base. */
export default function remarkBaseLinks({ base = '/' } = {}) {
	const prefix = `/${base.split('/').filter(Boolean).join('/')}`;
	const withBase = (url) => {
		if (prefix === '/' || !url.startsWith('/') || url.startsWith('//')) return url;
		if (url === prefix || url.startsWith(`${prefix}/`)) return url;
		return `${prefix}${url}`;
	};
	return (tree) => {
		visit(tree, (node) => {
			if (node.type === 'link' || node.type === 'definition' || node.type === 'image') {
				node.url = withBase(node.url);
			}
			if (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') {
				for (const attribute of node.attributes) {
					if (attribute.type === 'mdxJsxAttribute' && ['href', 'src'].includes(attribute.name) && typeof attribute.value === 'string') {
						attribute.value = withBase(attribute.value);
					}
				}
			}
		});
	};
}
