// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Data helpers for the contributors thank-you section. The browser reads
// GitHub's repository contributor statistics directly. This module has no
// DOM dependencies so it can be unit-tested in Node.

const REPOSITORY = 'microsoft/scope';
export const CONTRIBUTORS_DATA_URL = `https://api.github.com/repos/${REPOSITORY}/contributors?anon=0&per_page=100`;
export const CONTRIBUTORS_GRAPH_URL = `https://github.com/${REPOSITORY}/graphs/contributors`;

export interface Contributor {
	/** GitHub account login. */
	login: string;
	/** Number of commits attributed on the repository's default branch. */
	commits: number;
}

export interface ContributorsResult {
	contributors: Contributor[];
	/** 1-based line numbers that were skipped because they were invalid. */
	skipped: number[];
}

// GitHub logins: alphanumerics and single hyphens, up to 39 characters.
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** Validates a GitHub contributor record before it enters the browser model. */
function parseContributor(value: unknown): Contributor | undefined {
	if (typeof value !== 'object' || value === null) return undefined;
	const record = value as Record<string, unknown>;
	const { contributions, login, type } = record;
	if (typeof login !== 'string' || !LOGIN.test(login)) return undefined;
	if (type !== 'User' || login.endsWith('[bot]')) return undefined;
	if (typeof contributions !== 'number' || !Number.isSafeInteger(contributions) || contributions <= 0) return undefined;
	return { login, commits: contributions };
}

/**
 * Parses GitHub's contributor array. Invalid entries, bot accounts and
 * duplicate logins are skipped so one bad entry can't hide the list.
 */
export function parseContributors(value: unknown): ContributorsResult {
	const contributors: Contributor[] = [];
	const skipped: number[] = [];
	const seen = new Set<string>();
	if (!Array.isArray(value)) return { contributors, skipped: [1] };
	value.forEach((entry, index) => {
		const contributor = parseContributor(entry);
		if (!contributor || seen.has(contributor.login.toLowerCase())) {
			skipped.push(index + 1);
			return;
		}
		seen.add(contributor.login.toLowerCase());
		contributors.push(contributor);
	});
	return { contributors, skipped };
}

/** Returns the URL GitHub identifies as the next page, when present. */
function nextPageUrl(link: string | null): string | undefined {
	if (!link) return undefined;
	for (const part of link.split(',')) {
		const match = part.match(/^\s*<([^>]+)>;\s*rel="([^"]+)"\s*$/);
		if (match?.[2].split(/\s+/).includes('next')) return match[1];
	}
	return undefined;
}

/** Display order: most commits first, then by login. */
export function sortForDisplay(contributors: readonly Contributor[]): Contributor[] {
	return [...contributors].sort((a, b) => b.commits - a.commits || a.login.localeCompare(b.login, 'en', { sensitivity: 'base' }));
}

export function avatarUrl(login: string, size = 96): string {
	return `https://github.com/${encodeURIComponent(login)}.png?size=${size}`;
}

/** The contributor's merged pull requests in this repository. */
export function prsUrl(login: string): string {
	const query = `is:pr is:merged author:${login}`;
	return `https://github.com/${REPOSITORY}/pulls?q=${encodeURIComponent(query)}`;
}

export function commitsLabel(count: number): string {
	return count === 1 ? '1 commit on main' : `${count} commits on main`;
}

export function contributorsLabel(count: number): string {
	return count === 1 ? 'contributor' : 'contributors';
}

export function totalCommits(contributors: readonly Contributor[]): number {
	return contributors.reduce((sum, contributor) => sum + contributor.commits, 0);
}

/** Splits the list into what fits under `limit` and how many are left over. */
export function visible<T>(items: readonly T[], limit: number): { shown: T[]; hidden: number } {
	if (!Number.isFinite(limit) || limit <= 0 || items.length <= limit) return { shown: [...items], hidden: 0 };
	// Keep a slot for the "+N" bubble so the wall never exceeds `limit` items.
	const shown = items.slice(0, limit - 1);
	return { shown, hidden: items.length - shown.length };
}

/**
 * First page of the grid: `limit` items, or all of them when at most one
 * more would remain, so "Show all" never reveals a single card.
 */
export function firstPage<T>(items: readonly T[], limit: number): { shown: T[]; hidden: number } {
	return visible(items, limit + 1);
}

/** Label of the grid's "Show all" button. */
export function showAllLabel(total: number): string {
	return `Show all ${total} ${contributorsLabel(total)}`;
}

/**
 * Horizontal shift that keeps a tooltip, centered on an avatar and scaled
 * by `scale` on hover, inside `[left, right]`. A tip wider than the bounds
 * stays aligned to the left edge.
 */
export function tipShift(center: number, halfWidth: number, left: number, right: number, scale = 1): number {
	const min = (left - center) / scale + halfWidth;
	const max = (right - center) / scale - halfWidth;
	return min > 0 ? min : max < 0 ? max : 0;
}

/** Fetches and parses every GitHub contributor page. */
export async function fetchContributors(url: string, timeoutMs = 8000): Promise<ContributorsResult> {
	const records: unknown[] = [];
	const visited = new Set<string>();
	let pageUrl: string | undefined = url;

	while (pageUrl) {
		if (visited.has(pageUrl)) throw new Error('Contributors pagination loop detected');
		visited.add(pageUrl);

		const response = await fetch(pageUrl, {
			headers: { Accept: 'application/vnd.github+json' },
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) throw new Error(`Contributors request failed: HTTP ${response.status}`);

		const page: unknown = await response.json();
		if (!Array.isArray(page)) throw new Error('Contributors response was not an array');
		records.push(...page);
		pageUrl = nextPageUrl(response.headers.get('link'));
	}

	return parseContributors(records);
}
