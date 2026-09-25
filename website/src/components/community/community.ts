// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { getCollection, type CollectionEntry } from 'astro:content';

export type Article = CollectionEntry<'articles'>;
export type Talk = CollectionEntry<'talks'>;
export type Person = Article['data']['authors'][number];

/** Articles, newest first; undated articles last, alphabetically. */
export async function getArticles(): Promise<Article[]> {
	const entries = await getCollection('articles');
	return entries.sort((a, b) => {
		const da = a.data.date?.getTime();
		const db = b.data.date?.getTime();
		if (da !== undefined && db !== undefined && da !== db) return db - da;
		if (da === undefined && db !== undefined) return 1;
		if (da !== undefined && db === undefined) return -1;
		return a.data.title.localeCompare(b.data.title);
	});
}

/** Talks, newest first. */
export async function getTalks(): Promise<Talk[]> {
	const entries = await getCollection('talks');
	return entries.sort(
		(a, b) =>
			b.data.date.getTime() - a.data.date.getTime() ||
			a.data.title.localeCompare(b.data.title),
	);
}

// YAML dates parse as UTC midnight, so format in UTC to avoid
// shifting to the previous day in western time zones.
const dateFormat = new Intl.DateTimeFormat('en-US', {
	year: 'numeric',
	month: 'long',
	day: 'numeric',
	timeZone: 'UTC',
});

export function formatDate(date: Date): string {
	return dateFormat.format(date);
}

export function isoDate(date: Date): string {
	return date.toISOString().slice(0, 10);
}
