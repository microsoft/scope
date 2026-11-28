// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Runs under Node's built-in test runner (`pnpm test`), which strips the
// TypeScript types from the imported module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
	avatarUrl,
	commitsLabel,
	contributorsLabel,
	fetchContributors,
	firstPage,
	parseContributors,
	prsUrl,
	showAllLabel,
	sortForDisplay,
	tipShift,
	totalCommits,
	visible,
} from './contributors.ts';

test('parses GitHub contributor records', () => {
	const records = [
		{ contributions: 2, login: 'ada', type: 'User' },
		{ contributions: 1, login: 'grace-h', type: 'User' },
	];
	assert.deepEqual(parseContributors(records), {
		contributors: [{ login: 'ada', commits: 2 }, { login: 'grace-h', commits: 1 }],
		skipped: [],
	});
});

test('treats an empty array as no contributors', () => {
	assert.deepEqual(parseContributors([]), { contributors: [], skipped: [] });
});

test('rejects a non-array response', () => {
	assert.deepEqual(parseContributors({ message: 'rate limited' }), {
		contributors: [],
		skipped: [1],
	});
});

test('skips bots, anonymous records, invalid values and duplicates', () => {
	const records = [
		{ contributions: 9, login: 'dependabot[bot]', type: 'Bot' },
		{ contributions: 1, email: 'anonymous@example.com', type: 'Anonymous' },
		{ contributions: 1, login: '-leading', type: 'User' },
		{ contributions: 1, login: 'double--hyphen', type: 'User' },
		{ contributions: 1, login: '../evil', type: 'User' },
		{ contributions: 0, login: 'zero', type: 'User' },
		{ contributions: 1.5, login: 'fraction', type: 'User' },
		{ contributions: 3, login: 'Kept', type: 'User' },
		{ contributions: 1, login: 'kept', type: 'User' },
	];
	const { contributors, skipped } = parseContributors(records);
	assert.deepEqual(contributors, [{ login: 'Kept', commits: 3 }]);
	assert.deepEqual(skipped, [1, 2, 3, 4, 5, 6, 7, 9]);
});

test('follows GitHub pagination links', async (context) => {
	const originalFetch = globalThis.fetch;
	context.after(() => { globalThis.fetch = originalFetch; });
	const pages = new Map([
		['https://api.example.test/contributors', new Response(
			JSON.stringify([{ contributions: 2, login: 'ada', type: 'User' }]),
			{ headers: { link: '<https://api.example.test/contributors?page=2>; rel="next", <https://api.example.test/contributors?page=2>; rel="last"' } },
		)],
		['https://api.example.test/contributors?page=2', new Response(
			JSON.stringify([{ contributions: 1, login: 'grace-h', type: 'User' }]),
		)],
	]);
	globalThis.fetch = async (url) => pages.get(String(url)) ?? new Response('', { status: 404 });

	assert.deepEqual(await fetchContributors('https://api.example.test/contributors'), {
		contributors: [{ login: 'ada', commits: 2 }, { login: 'grace-h', commits: 1 }],
		skipped: [],
	});
});

test('sorts by commits, then login case-insensitively', () => {
	const sorted = sortForDisplay([
		{ login: 'zed', commits: 1 },
		{ login: 'Bea', commits: 1 },
		{ login: 'max', commits: 4 },
		{ login: 'alex', commits: 1 },
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

test('pluralizes labels and totals commits', () => {
	assert.equal(commitsLabel(1), '1 commit on main');
	assert.equal(commitsLabel(3), '3 commits on main');
	assert.equal(contributorsLabel(1), 'contributor');
	assert.equal(contributorsLabel(2), 'contributors');
	assert.equal(totalCommits([{ login: 'a', commits: 2 }, { login: 'b', commits: 3 }]), 5);
	assert.equal(totalCommits([]), 0);
});

test('keeps a slot for the overflow bubble', () => {
	const items = [1, 2, 3, 4, 5, 6];
	assert.deepEqual(visible(items, 10), { shown: items, hidden: 0 });
	assert.deepEqual(visible(items, 6), { shown: items, hidden: 0 });
	assert.deepEqual(visible(items, 4), { shown: [1, 2, 3], hidden: 3 });
	assert.deepEqual(visible(items, Infinity), { shown: items, hidden: 0 });
});

test('pages the grid without hiding a single card', () => {
	const items = [1, 2, 3, 4, 5, 6];
	assert.deepEqual(firstPage(items, 3), { shown: [1, 2, 3], hidden: 3 });
	assert.deepEqual(firstPage(items, 4), { shown: [1, 2, 3, 4], hidden: 2 });
	assert.deepEqual(firstPage(items, 5), { shown: items, hidden: 0 });
	assert.deepEqual(firstPage(items, Infinity), { shown: items, hidden: 0 });
	assert.deepEqual(firstPage([], 30), { shown: [], hidden: 0 });
});

test('labels the show all button', () => {
	assert.equal(showAllLabel(31), 'Show all 31 contributors');
	assert.equal(showAllLabel(1), 'Show all 1 contributor');
});

test('keeps a centered tooltip in place', () => {
	assert.equal(tipShift(500, 40, 0, 1000, 1.14), 0);
	assert.equal(tipShift(500, 40, 0, 1000), 0);
});

test('shifts edge tooltips inside the bounds, even when scaled', () => {
	const left = 10;
	const right = 375;
	const scale = 1.14;
	const half = 60;
	for (const center of [12, 30, 70, 190, 330, 360, 373]) {
		const shift = tipShift(center, half, left, right, scale);
		const tipLeft = center + scale * (shift - half);
		const tipRight = center + scale * (shift + half);
		assert.ok(tipLeft >= left - 1e-9, `left edge at center ${center}`);
		assert.ok(tipRight <= right + 1e-9, `right edge at center ${center}`);
	}
	assert.ok(tipShift(12, half, left, right, scale) > 0);
	assert.ok(tipShift(373, half, left, right, scale) < 0);
});

test('aligns a tooltip wider than the bounds to the left edge', () => {
	const shift = tipShift(50, 80, 0, 100, 1);
	assert.equal(50 + shift - 80, 0);
});

test('the dev sample file matches GitHub and is sorted by login', () => {
	const value = JSON.parse(readFileSync(new URL('../data/contributors.sample.json', import.meta.url), 'utf8'));
	const { contributors, skipped } = parseContributors(value);
	assert.deepEqual(skipped, []);
	assert.ok(contributors.length >= 1);
	const logins = contributors.map((c) => c.login.toLowerCase());
	assert.deepEqual(logins, [...logins].sort());
	for (const record of value) {
		assert.deepEqual(Object.keys(record), ['contributions', 'login', 'type']);
	}
});
