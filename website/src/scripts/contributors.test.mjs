// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Runs under Node's built-in test runner (`pnpm test`), which strips the
// TypeScript types from the imported module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
	avatarUrl,
	contributorsLabel,
	parseContributors,
	prsLabel,
	prsUrl,
	sortForDisplay,
	totalPrs,
	visible,
} from './contributors.ts';

const line = (value) => JSON.stringify(value);

test('parses JSON Lines and ignores blank lines', () => {
	const text = [line({ login: 'ada', prs: 2 }), '', line({ login: 'grace-h', prs: 1 }), ''].join('\n');
	assert.deepEqual(parseContributors(text), {
		contributors: [{ login: 'ada', prs: 2 }, { login: 'grace-h', prs: 1 }],
		skipped: [],
	});
});

test('treats an empty file as no contributors', () => {
	assert.deepEqual(parseContributors(''), { contributors: [], skipped: [] });
});

test('skips invalid logins, counts and duplicates without dropping the rest', () => {
	const text = [
		'{not json',
		line({ login: 'dependabot[bot]', prs: 9 }),
		line({ login: '-leading', prs: 1 }),
		line({ login: 'double--hyphen', prs: 1 }),
		line({ login: '../evil', prs: 1 }),
		line({ login: 'zero', prs: 0 }),
		line({ login: 'fraction', prs: 1.5 }),
		line({ login: 'Kept', prs: 3 }),
		line({ login: 'kept', prs: 1 }),
	].join('\r\n');
	const { contributors, skipped } = parseContributors(text);
	assert.deepEqual(contributors, [{ login: 'Kept', prs: 3 }]);
	assert.deepEqual(skipped, [1, 2, 3, 4, 5, 6, 7, 9]);
});

test('sorts by merged PRs, then login case-insensitively', () => {
	const sorted = sortForDisplay([
		{ login: 'zed', prs: 1 },
		{ login: 'Bea', prs: 1 },
		{ login: 'max', prs: 4 },
		{ login: 'alex', prs: 1 },
	]);
	assert.deepEqual(sorted.map((c) => c.login), ['max', 'alex', 'Bea', 'zed']);
});

test('builds avatar and merged PR URLs', () => {
	assert.equal(avatarUrl('ada'), 'https://github.com/ada.png?size=96');
	assert.equal(avatarUrl('ada', 160), 'https://github.com/ada.png?size=160');
	const url = new URL(prsUrl('grace-h'));
	assert.equal(url.pathname, '/microsoft/scope/pulls');
	assert.equal(url.searchParams.get('q'), 'is:pr is:merged author:grace-h');
});

test('pluralizes labels and totals PRs', () => {
	assert.equal(prsLabel(1), '1 merged PR');
	assert.equal(prsLabel(3), '3 merged PRs');
	assert.equal(contributorsLabel(1), 'contributor');
	assert.equal(contributorsLabel(2), 'contributors');
	assert.equal(totalPrs([{ login: 'a', prs: 2 }, { login: 'b', prs: 3 }]), 5);
	assert.equal(totalPrs([]), 0);
});

test('keeps a slot for the overflow bubble', () => {
	const items = [1, 2, 3, 4, 5, 6];
	assert.deepEqual(visible(items, 10), { shown: items, hidden: 0 });
	assert.deepEqual(visible(items, 6), { shown: items, hidden: 0 });
	assert.deepEqual(visible(items, 4), { shown: [1, 2, 3], hidden: 3 });
	assert.deepEqual(visible(items, Infinity), { shown: items, hidden: 0 });
});

test('the dev sample file is valid and sorted like the published file', () => {
	const text = readFileSync(new URL('../data/contributors.sample.jsonl', import.meta.url), 'utf8');
	const { contributors, skipped } = parseContributors(text);
	assert.deepEqual(skipped, []);
	assert.ok(contributors.length >= 1);
	const logins = contributors.map((c) => c.login.toLowerCase());
	assert.deepEqual(logins, [...logins].sort());
	for (const raw of text.trim().split('\n')) {
		assert.deepEqual(Object.keys(JSON.parse(raw)), ['login', 'prs'], 'keys are sorted and nothing else is published');
	}
});
