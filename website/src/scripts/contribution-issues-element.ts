// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
	DATA_URL,
	chips,
	contributionLabels,
	countLabel,
	fetchIssues,
	issueUrl,
	parseIssues,
	sortForDisplay,
	type ContributionIssue,
	type ParseResult,
} from './contribution-issues';

type State = 'loading' | 'ready' | 'empty' | 'error';

const EASE_OUT_BACK = 'cubic-bezier(0.34, 1.56, 0.64, 1)';
const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';
const STAGGER_MS = 70;
const MAX_STAGGER_STEPS = 8;
const COUNT_UP_MS = 900;

const BADGE_TEXT = { 'good first issue': 'Good first issue', 'help wanted': 'Help wanted' } as const;

/**
 * Renders the open "call for contributions" issues. Without JavaScript the
 * server-rendered fallback links stay visible. Motion is skipped entirely
 * when the visitor prefers reduced motion.
 */
class ScopeContributionIssues extends HTMLElement {
	private motion = window.matchMedia('(prefers-reduced-motion: reduce)');
	private observer: IntersectionObserver | undefined;
	private events: AbortController | undefined;
	private inView = false;
	private loaded = false;
	private headingRevealed = false;
	private itemsRevealed = false;
	private total = 0;

	connectedCallback() {
		this.events = new AbortController();
		this.toggleAttribute('data-animate', this.animates);
		this.observer = new IntersectionObserver((entries) => {
			if (!entries.some((entry) => entry.isIntersecting)) return;
			this.inView = true;
			this.observer?.disconnect();
			this.reveal();
		}, { rootMargin: '0px 0px -12% 0px' });
		this.observer.observe(this);
		this.trackPointer(this.events.signal);
		void this.load();
	}

	disconnectedCallback() {
		this.observer?.disconnect();
		this.events?.abort();
	}

	private get animates() {
		return !this.motion.matches && typeof Element.prototype.animate === 'function';
	}

	private async load() {
		let result: ParseResult;
		let sample = false;
		try {
			result = await fetchIssues(this.dataset.src || DATA_URL);
		} catch (error) {
			// In local dev the data branch may not exist yet, or there may be no
			// network. Fall back to the committed sample. The DEV branch is
			// removed from production builds, sample included.
			if (import.meta.env.DEV) {
				console.info('[contribution-issues] Live list unavailable; using the dev sample.', error);
				const { default: text } = await import('../data/contribution-issues.sample.jsonl?raw');
				result = parseIssues(text);
				sample = true;
			} else {
				console.warn('[contribution-issues] Could not load the live list.', error);
				this.setState('error');
				return;
			}
		}
		if (result.skipped.length) {
			console.warn(`[contribution-issues] Skipped invalid lines: ${result.skipped.join(', ')}`);
		}
		this.querySelectorAll<HTMLElement>('[data-sample-tag]').forEach((tag) => { tag.hidden = !sample; });
		await this.render(result.issues);
	}

	private async render(issues: ContributionIssue[]) {
		const list = this.querySelector<HTMLElement>('[data-list]');
		if (!list) throw new Error('Missing contribution issues list');
		const sorted = sortForDisplay(issues);
		const limit = Number(this.dataset.limit) || Infinity;
		this.total = sorted.length;

		// Fade the skeleton out before swapping in real items, when on screen.
		if (this.animates && this.inView) {
			await list.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-out' }).finished.catch(() => undefined);
		}
		list.replaceChildren(...sorted.slice(0, limit).map((issue) => this.item(issue)));
		list.removeAttribute('aria-busy');
		this.querySelectorAll('[data-count-label]').forEach((label) => { label.textContent = countLabel(this.total); });
		this.querySelectorAll('[data-count-text]').forEach((text) => { text.textContent = `${this.total} ${countLabel(this.total)}`; });
		this.loaded = true;
		this.setState(this.total ? 'ready' : 'empty');
		this.reveal();
	}

	private setState(state: State) {
		this.dataset.state = state;
		if (state !== 'loading') this.querySelector('[data-list]')?.removeAttribute('aria-busy');
	}

	/** Runs entrance animations once the section is visible and data is in. */
	private reveal() {
		if (!this.inView) return;
		if (!this.headingRevealed) {
			this.headingRevealed = true;
			this.enter([...this.querySelectorAll<HTMLElement>('[data-reveal]')], 0, 90);
		}
		if (this.loaded && !this.itemsRevealed) {
			this.itemsRevealed = true;
			this.enter([...this.querySelectorAll<HTMLElement>('[data-reveal-item]')], 180, STAGGER_MS);
			if (this.total) this.countUp();
		}
	}

	private enter(elements: HTMLElement[], baseDelay: number, stagger: number) {
		elements.forEach((element, index) => {
			element.dataset.revealed = '';
			if (!this.animates) return;
			element.animate(
				[{ opacity: 0, transform: 'translateY(18px) scale(0.98)' }, { opacity: 1, transform: 'none' }],
				{ duration: 650, delay: baseDelay + Math.min(index, MAX_STAGGER_STEPS) * stagger, easing: EASE_OUT_BACK, fill: 'backwards' },
			);
		});
	}

	private countUp() {
		const pill = this.querySelector<HTMLElement>('[data-count-pill]');
		const counter = this.querySelector<HTMLElement>('[data-count]');
		if (!pill || !counter) return;
		pill.dataset.shown = '';
		if (!this.animates) {
			counter.textContent = String(this.total);
			return;
		}
		pill.animate([{ opacity: 0, transform: 'scale(0.85)' }, { opacity: 1, transform: 'none' }], { duration: 500, easing: EASE_OUT_BACK, fill: 'backwards' });
		const start = performance.now();
		const tick = (now: number) => {
			const progress = Math.min((now - start) / COUNT_UP_MS, 1);
			counter.textContent = String(Math.round(this.total * (1 - (1 - progress) ** 3)));
			if (progress < 1) requestAnimationFrame(tick);
		};
		counter.textContent = '0';
		requestAnimationFrame(tick);
	}

	/** Feeds the cursor position to the card glow through CSS variables. */
	private trackPointer(signal: AbortSignal) {
		this.addEventListener('pointermove', (event) => {
			if (this.motion.matches || !(event.target instanceof Element)) return;
			const card = event.target.closest<HTMLElement>('.contrib-card');
			if (!card || !this.contains(card)) return;
			const rect = card.getBoundingClientRect();
			card.style.setProperty('--x', `${event.clientX - rect.left}px`);
			card.style.setProperty('--y', `${event.clientY - rect.top}px`);
		}, { signal, passive: true });
	}

	// Issue titles and labels are user-supplied, so every value is set as text.
	private item(issue: ContributionIssue): HTMLLIElement {
		const item = document.createElement('li');
		item.className = 'contrib-item';
		item.dataset.revealItem = '';

		const link = document.createElement('a');
		link.className = 'contrib-card';
		link.href = issueUrl(issue.number);
		link.target = '_blank';
		link.rel = 'noopener noreferrer';

		this.text(link, 'span', issue.title, 'contrib-card__title');

		const top = this.el(link, 'span', 'contrib-card__top');
		const badges = this.el(top, 'span', 'contrib-badges');
		for (const label of contributionLabels(issue)) {
			this.text(badges, 'span', BADGE_TEXT[label], 'contrib-badge').dataset.label = label.replace(/\s+/g, '-');
		}
		const number = this.el(top, 'span', 'contrib-number');
		this.text(number, 'span', 'Issue ', 'sr-only');
		number.append(`#${issue.number}`);

		const issueChips = chips(issue);
		if (issueChips.length) {
			const row = this.el(link, 'span', 'contrib-chips');
			for (const chip of issueChips) {
				const element = this.text(row, 'span', chip.value, 'contrib-chip');
				element.dataset.kind = chip.kind;
				element.dataset.value = chip.value.toLowerCase();
				element.title = chip.label;
			}
		}

		const cta = this.el(link, 'span', 'contrib-card__cta');
		cta.append('View on GitHub');
		this.text(cta, 'span', '↗', 'contrib-card__arrow').setAttribute('aria-hidden', 'true');
		this.text(link, 'span', ' (opens in a new tab)', 'sr-only');

		item.append(link);
		return item;
	}

	private el(parent: Element, tag: 'span', className: string): HTMLElement {
		const element = document.createElement(tag);
		element.className = className;
		parent.append(element);
		return element;
	}

	private text(parent: Element, tag: 'span', value: string, className: string): HTMLElement {
		const element = this.el(parent, tag, className);
		element.textContent = value;
		return element;
	}
}

if (!customElements.get('scope-contribution-issues')) customElements.define('scope-contribution-issues', ScopeContributionIssues);
