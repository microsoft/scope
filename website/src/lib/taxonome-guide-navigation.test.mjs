// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from 'node:assert/strict';
import test from 'node:test';
import { taxonomeGuideNavigation } from './taxonome-guide-navigation.mjs';

test('groups the Taxonome guides in the approved order', () => {
	assert.deepEqual(taxonomeGuideNavigation, {
		label: 'Use and design taxonomies',
		collapsed: false,
		items: [
			{ label: 'Using Taxonome', slug: 'guides/taxonome' },
			{ label: 'Create your own taxonomy', slug: 'guides/create-taxonomy' },
		],
	});
});
