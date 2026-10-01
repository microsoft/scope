// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Data helpers for the "call for contributions" issue list. The list is
// published as JSON Lines on the `website-data` branch by
// .github/workflows/contribution-issues.yml and fetched in the browser.
// This module has no DOM dependencies so it can be unit-tested in Node.

export const REPOSITORY = 'microsoft/scope';
export const DATA_URL = `https://raw.githubusercontent.com/${REPOSITORY}/website-data/issues.jsonl`;
export const CONTRIBUTION_LABELS = ['good first issue', 'help wanted'] as const;

export type ContributionLabel = (typeof CONTRIBUTION_LABELS)[number];

export interface ContributionIssue {
	number: number;
	title: string;
	labels: string[];
}

export interface ParseResult {
	issues: ContributionIssue[];
	/** 1-based line numbers that were skipped because they were invalid. */
	skipped: number[];
}

/** Label prefixes shown as chips; all other labels stay hidden. */
const CHIP_PREFIXES = ['area', 'difficulty', 'type'] as const;
export type ChipKind = (typeof CHIP_PREFIXES)[number];

export interface Chip {
	kind: ChipKind;
	value: string;
	label: string;
}

function isIssue(value: unknown): value is ContributionIssue {
	if (typeof value !== 'object' || value === null) return false;
	const { number, title, labels } = value as Record<string, unknown>;
	return (
		Number.isSafeInteger(number) &&
		(number as number) > 0 &&
		typeof title === 'string' &&
		title.trim() !== '' &&
		Array.isArray(labels) &&
		labels.every((label) => typeof label === 'string')
	);
}

/**
 * Parses the JSON Lines payload. Invalid lines, and lines without a
 * contribution label, are skipped so one bad line can't hide the list.
 */
export function parseIssues(text: string): ParseResult {
	const issues: ContributionIssue[] = [];
	const skipped: number[] = [];
	const seen = new Set<number>();
	text.split(/\r?\n/).forEach((line, index) => {
		if (line.trim() === '') return;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			skipped.push(index + 1);
			return;
		}
		if (!isIssue(value) || !contributionLabels(value).length || seen.has(value.number)) {
			skipped.push(index + 1);
			return;
		}
		seen.add(value.number);
		issues.push({ number: value.number, title: value.title.trim(), labels: [...value.labels] });
	});
	return { issues, skipped };
}

/** The contribution labels an issue carries, `good first issue` first. */
export function contributionLabels(issue: Pick<ContributionIssue, 'labels'>): ContributionLabel[] {
	return CONTRIBUTION_LABELS.filter((label) => issue.labels.includes(label));
}

/** Display order: `good first issue` first, then newest (highest number). */
export function sortForDisplay(issues: readonly ContributionIssue[]): ContributionIssue[] {
	const rank = (issue: ContributionIssue) => (issue.labels.includes('good first issue') ? 0 : 1);
	return [...issues].sort((a, b) => rank(a) - rank(b) || b.number - a.number);
}

/** `area:`, `difficulty:` and `type:` labels as chips, in that order. */
export function chips(issue: Pick<ContributionIssue, 'labels'>): Chip[] {
	const result: Chip[] = [];
	for (const kind of CHIP_PREFIXES) {
		for (const label of issue.labels) {
			const match = /^([a-z]+):\s*(.+)$/i.exec(label);
			if (match && match[1].toLowerCase() === kind) result.push({ kind, value: match[2].trim(), label });
		}
	}
	return result;
}

export function issueUrl(number: number): string {
	return `https://github.com/${REPOSITORY}/issues/${number}`;
}

/** GitHub issue search for open, unassigned issues with the given label. */
export function searchUrl(label: ContributionLabel): string {
	const query = `is:issue is:open no:assignee label:"${label}"`;
	return `https://github.com/${REPOSITORY}/issues?q=${encodeURIComponent(query)}`;
}

export function countLabel(count: number): string {
	return count === 1 ? 'open call' : 'open calls';
}

/** Number of rotation pages needed to show `total` items `size` at a time. */
export function pageCount(total: number, size: number): number {
	if (total <= 0 || size <= 0) return 0;
	return Math.ceil(total / size);
}

/**
 * Items on a rotation page. A short last page wraps around to the start,
 * so every page is full when there are at least `size` items.
 */
export function pageItems<T>(items: readonly T[], page: number, size: number): T[] {
	if (!items.length || size <= 0) return [];
	if (items.length <= size) return [...items];
	const start = page * size;
	return Array.from({ length: size }, (_, index) => items[(start + index) % items.length]!);
}

/** Fetches and parses the published list. Throws on network or HTTP errors. */
export async function fetchIssues(url: string, timeoutMs = 8000): Promise<ParseResult> {
	const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
	if (!response.ok) throw new Error(`Contribution issues request failed: HTTP ${response.status}`);
	return parseIssues(await response.text());
}
