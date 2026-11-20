// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Data helpers for the contributors thank-you section. The list is
// published as JSON Lines on the `website-data` branch by
// .github/workflows/contribution-data.yml and fetched in the browser.
// This module has no DOM dependencies so it can be unit-tested in Node.

const REPOSITORY = 'microsoft/scope';
export const CONTRIBUTORS_DATA_URL = `https://raw.githubusercontent.com/${REPOSITORY}/website-data/contributors.jsonl`;
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

/** Normalizes current and legacy published records into the browser model. */
function parseContributor(value: unknown): Contributor | undefined {
	if (typeof value !== 'object' || value === null) return undefined;
	const record = value as Record<string, unknown>;
	const { login } = record;
	const commits = Object.hasOwn(record, 'commits') ? record.commits : record.prs;
	if (typeof login !== 'string' || !LOGIN.test(login)) return undefined;
	if (typeof commits !== 'number' || !Number.isSafeInteger(commits) || commits <= 0) return undefined;
	if (Object.hasOwn(record, 'commits') && Object.hasOwn(record, 'prs') && record.prs !== commits) return undefined;
	return { login, commits };
}

/**
 * Parses the JSON Lines payload. Invalid lines, bot accounts and duplicate
 * logins are skipped so one bad line can't hide the list.
 */
export function parseContributors(text: string): ContributorsResult {
	const contributors: Contributor[] = [];
	const skipped: number[] = [];
	const seen = new Set<string>();
	text.split(/\r?\n/).forEach((line, index) => {
		if (line.trim() === '') return;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			skipped.push(index + 1);
			return;
		}
		const contributor = parseContributor(value);
		if (!contributor || seen.has(contributor.login.toLowerCase())) {
			skipped.push(index + 1);
			return;
		}
		seen.add(contributor.login.toLowerCase());
		contributors.push(contributor);
	});
	return { contributors, skipped };
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

/** Fetches and parses the published list. Throws on network or HTTP errors. */
export async function fetchContributors(url: string, timeoutMs = 8000): Promise<ContributorsResult> {
	const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
	if (!response.ok) throw new Error(`Contributors request failed: HTTP ${response.status}`);
	return parseContributors(await response.text());
}
