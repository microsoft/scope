// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTaxonomeCatalog } from './taxonome-catalog.mjs';

test('loads the canonical Ax taxonomy in manifest order', async () => {
	const catalog = await loadTaxonomeCatalog();
	assert.equal(catalog.id, 'ax-taxonomy');
	assert.equal(catalog.version, '1.0.0');
	assert.deepEqual(
		catalog.elements.map((element) => element.id),
		[
			'beh-discovered',
			'beh-skipped-invocation',
			'beh-wrong-discovery',
			'beh-content-misused',
			'beh-malformed-invocation',
			'beh-timeout',
		],
	);
});
