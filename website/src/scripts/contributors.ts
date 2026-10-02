// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Data helpers for the community contributors thank-you section. The list is
// published as JSON Lines on the `website-data` branch by
// .github/workflows/contribution-issues.yml and fetched in the browser.
// This module has no DOM dependencies so it can be unit-tested in Node.

const REPOSITORY = 'microsoft/scope';
export const CONTRIBUTORS_DATA_URL = `https://raw.githubusercontent.com/${REPOSITORY}/website-data/contributors.jsonl`;
export const CONTRIBUTORS_GRAPH_URL = `https://github.com/${REPOSITORY}/graphs/contributors`;

export interface Contributor {
	login: string;
	/** Number of merged pull requests. */
	prs: number;
}

export interface ContributorsResult {
	contributors: Contributor[];
	/** 1-based line numbers that were skipped because they were invalid. */
	skipped: number[];
}

// GitHub logins: alphanumerics and single hyphens, up to 39 characters.
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

function isContributor(value: unknown): value is Contributor {
	if (typeof value !== 'object' || value === null) return false;
	const { login, prs } = value as Record<string, unknown>;
	return typeof login === 'string' && LOGIN.test(login) && Number.isSafeInteger(prs) && (prs as number) > 0;
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
		if (!isContributor(value) || seen.has(value.login.toLowerCase())) {
			skipped.push(index + 1);
			return;
		}
		seen.add(value.login.toLowerCase());
		contributors.push({ login: value.login, prs: value.prs });
	});
	return { contributors, skipped };
}

/** Display order: most merged PRs first, then by login. */
export function sortForDisplay(contributors: readonly Contributor[]): Contributor[] {
	return [...contributors].sort((a, b) => b.prs - a.prs || a.login.localeCompare(b.login, 'en', { sensitivity: 'base' }));
}

export function avatarUrl(login: string, size = 96): string {
	return `https://github.com/${encodeURIComponent(login)}.png?size=${size}`;
}

/** The contributor's merged pull requests in this repository. */
export function prsUrl(login: string): string {
	const query = `is:pr is:merged author:${login}`;
	return `https://github.com/${REPOSITORY}/pulls?q=${encodeURIComponent(query)}`;
}

export function prsLabel(count: number): string {
	return count === 1 ? '1 merged PR' : `${count} merged PRs`;
}

export function contributorsLabel(count: number): string {
	return count === 1 ? 'contributor' : 'contributors';
}

export function totalPrs(contributors: readonly Contributor[]): number {
	return contributors.reduce((sum, contributor) => sum + contributor.prs, 0);
}

/** Splits the list into what fits under `limit` and how many are left over. */
export function visible<T>(items: readonly T[], limit: number): { shown: T[]; hidden: number } {
	if (!Number.isFinite(limit) || limit <= 0 || items.length <= limit) return { shown: [...items], hidden: 0 };
	// Keep a slot for the "+N" bubble so the wall never exceeds `limit` items.
	const shown = items.slice(0, limit - 1);
	return { shown, hidden: items.length - shown.length };
}

/** Fetches and parses the published list. Throws on network or HTTP errors. */
export async function fetchContributors(url: string, timeoutMs = 8000): Promise<ContributorsResult> {
	const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
	if (!response.ok) throw new Error(`Contributors request failed: HTTP ${response.status}`);
	return parseContributors(await response.text());
}
