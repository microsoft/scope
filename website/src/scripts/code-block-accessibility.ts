// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/** Makes horizontally scrollable code samples keyboard reachable and distinct. */
for (const [index, block] of document.querySelectorAll<HTMLElement>(
	'.expressive-code pre',
).entries()) {
	const language = block.dataset.language ?? 'text';
	block.tabIndex = 0;
	block.setAttribute('aria-label', `${language} code example ${index + 1}`);
}
