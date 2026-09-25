// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function readTables(page) {
	const html = await readFile(new URL(`../dist/${page}/index.html`, import.meta.url), 'utf8');
	return html.match(/<table\b[^>]*>[\s\S]*?<\/table>/g) ?? [];
}

function assertTable(table, headers, fields) {
	assert.deepEqual(
		Array.from(table.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g), ([, text]) => text),
		headers,
	);
	assert.deepEqual(
		Array.from(
			table.matchAll(/<tr\b[^>]*>\s*<td\b[^>]*><code\b[^>]*>([^<]+)<\/code>/g),
			([, field]) => field,
		),
		fields,
	);
	assert.equal(Array.from(table.matchAll(/<td\b/g)).length, headers.length * fields.length);
}

test('renders the MDX profile anatomy as a table with all fields and inline formatting', async () => {
	const tables = await readTables('guides/defining-profiles');
	assert.equal(tables.length, 1, 'The profile anatomy must render as an HTML table, not pipe-delimited text');
	assertTable(tables[0], ['Field', 'Layer', 'Description'], [
		'name',
		'description',
		'workerType',
		'model',
		'agentVersion',
		'mcpServers',
		'skillRevisions',
		'extensions',
	]);
	assert.match(tables[0], /<a href="[^"]*\/guides\/choosing-a-coding-agent\/">Choosing a coding agent<\/a>/);
	assert.match(tables[0], /<strong>VS Code Copilot only\.<\/strong>/);
});

test('preserves tables in the plain Markdown profile schema reference', async () => {
	const tables = await readTables('reference/profile-schema');
	assert.equal(tables.length, 2);
	assertTable(tables[0], ['Field', 'Type', 'Required', 'Description'], ['id', 'name', 'description']);
	assertTable(tables[1], ['Field', 'Type', 'Required', 'Description'], [
		'id',
		'profileId',
		'workerType',
		'model',
		'agentVersion',
		'mcpServers',
		'skillRevisions',
		'createdAt',
	]);
});
