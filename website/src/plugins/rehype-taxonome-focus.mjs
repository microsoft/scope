// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { visit } from 'unist-util-visit';

const isTaxonome = path => /(?:^|[/\\])taxonome(?:-[^/\\]+)?\.mdx?$/.test(path ?? '');

function focusScrollAreas(tree) {
	visit(tree, 'element', node => {
		if (['pre', 'table'].includes(node.tagName)) {
			node.properties ??= {};
			node.properties.tabIndex ??= 0;
		}
	});
}

/** Make the new references' overflowing code/tables keyboard-scrollable. */
export default function rehypeTaxonomeFocus() {
	return (tree, file) => {
		if (isTaxonome(file.path)) focusScrollAreas(tree);
	};
}
