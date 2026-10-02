// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Runs under Node's built-in test runner (`pnpm test`), which strips the
// TypeScript types from the imported module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
	chips,
	contributionLabels,
	countLabel,
	issueUrl,
	pageCount,
	pageItems,
	parseIssues,
	searchUrl,
	sortForDisplay,
} from './contribution-issues.ts';

const line = (issue) => JSON.stringify(issue);

test('parses JSON Lines and ignores blank lines', () => {
	const text = [
		line({ labels: ['good first issue'], number: 2, title: 'Two' }),
		'',
		line({ labels: ['help wanted'], number: 5, title: ' Five ' }),
		'',
	].join('\n');
	const { issues, skipped } = parseIssues(text);
	assert.deepEqual(issues, [
		{ number: 2, title: 'Two', labels: ['good first issue'] },
		{ number: 5, title: 'Five', labels: ['help wanted'] },
	]);
	assert.deepEqual(skipped, []);
});

test('treats an empty file as no issues', () => {
	assert.deepEqual(parseIssues(''), { issues: [], skipped: [] });
});

test('skips invalid, unlabeled and duplicate lines without dropping the rest', () => {
	const text = [
		'{not json',
		line({ labels: ['good first issue'], number: 0, title: 'Bad number' }),
		line({ labels: ['good first issue'], number: 3, title: '' }),
		line({ labels: ['area: portal'], number: 4, title: 'No contribution label' }),
		line({ labels: 'help wanted', number: 6, title: 'Labels not an array' }),
		line({ labels: ['help wanted'], number: 7, title: 'Kept' }),
		line({ labels: ['help wanted'], number: 7, title: 'Duplicate' }),
	].join('\r\n');
	const { issues, skipped } = parseIssues(text);
	assert.deepEqual(issues.map((issue) => issue.title), ['Kept']);
	assert.deepEqual(skipped, [1, 2, 3, 4, 5, 7]);
});

test('sorts good first issues first, then newest', () => {
	const sorted = sortForDisplay([
		{ number: 10, title: 'a', labels: ['help wanted'] },
		{ number: 3, title: 'b', labels: ['good first issue'] },
		{ number: 12, title: 'c', labels: ['help wanted'] },
		{ number: 8, title: 'd', labels: ['good first issue', 'help wanted'] },
	]);
	assert.deepEqual(sorted.map((issue) => issue.number), [8, 3, 12, 10]);
});

test('lists contribution labels in a fixed order', () => {
	assert.deepEqual(contributionLabels({ labels: ['help wanted', 'x', 'good first issue'] }), ['good first issue', 'help wanted']);
});

test('builds chips for area, difficulty and type labels only', () => {
	const result = chips({
		labels: ['type: documentation', 'priority: high', 'area: portal', 'good first issue', 'difficulty: easy', 'area: cli'],
	});
	assert.deepEqual(
		result.map(({ kind, value }) => `${kind}=${value}`),
		['area=portal', 'area=cli', 'difficulty=easy', 'type=documentation'],
	);
});

test('builds GitHub URLs', () => {
	assert.equal(issueUrl(42), 'https://github.com/microsoft/scope/issues/42');
	const url = new URL(searchUrl('good first issue'));
	assert.equal(url.searchParams.get('q'), 'is:issue is:open no:assignee label:"good first issue"');
});

test('pluralizes the count label', () => {
	assert.equal(countLabel(1), 'open call');
	assert.equal(countLabel(0), 'open calls');
	assert.equal(countLabel(4), 'open calls');
});

test('counts rotation pages', () => {
	assert.equal(pageCount(0, 4), 0);
	assert.equal(pageCount(3, 4), 1);
	assert.equal(pageCount(4, 4), 1);
	assert.equal(pageCount(9, 4), 3);
	assert.equal(pageCount(9, 0), 0);
});

test('fills every rotation page, wrapping the last one', () => {
	const items = [1, 2, 3, 4, 5, 6, 7, 8, 9];
	assert.deepEqual(pageItems(items, 0, 4), [1, 2, 3, 4]);
	assert.deepEqual(pageItems(items, 1, 4), [5, 6, 7, 8]);
	assert.deepEqual(pageItems(items, 2, 4), [9, 1, 2, 3]);
	assert.deepEqual(pageItems([1, 2], 0, 4), [1, 2]);
	assert.deepEqual(pageItems([], 0, 4), []);
});

test('the dev sample file is valid', () => {
	const text = readFileSync(new URL('../data/contribution-issues.sample.jsonl', import.meta.url), 'utf8');
	const { issues, skipped } = parseIssues(text);
	assert.deepEqual(skipped, []);
	assert.ok(issues.length >= 4);
	const numbers = issues.map((issue) => issue.number);
	assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b), 'sample is sorted by issue number like the published file');
	const labelSets = issues.map((issue) => contributionLabels(issue).join('+'));
	for (const combination of ['good first issue', 'help wanted', 'good first issue+help wanted']) {
		assert.ok(labelSets.includes(combination), `sample covers issues labeled ${combination}`);
	}
});
