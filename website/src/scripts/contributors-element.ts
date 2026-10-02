// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
	CONTRIBUTORS_DATA_URL,
	avatarUrl,
	contributorsLabel,
	fetchContributors,
	firstPage,
	parseContributors,
	prsLabel,
	prsUrl,
	showAllLabel,
	sortForDisplay,
	tipShift,
	totalPrs,
	visible,
	type Contributor,
	type ContributorsResult,
} from './contributors';

type State = 'loading' | 'ready' | 'empty' | 'error';

const EASE_OUT_BACK = 'cubic-bezier(0.34, 1.56, 0.64, 1)';
const COUNT_UP_MS = 900;
// Matches the hover/focus scale of `.thanks-avatar` in contributors.css.
const LIFT_SCALE = 1.14;
const MAX_STAGGER_STEPS = 24;

/**
 * Thanks contributors: authors of merged pull requests, bots aside. Renders
 * an avatar wall (landing) or a card grid (Contribute page). Without
 * JavaScript a link to the GitHub contributors graph stays visible. Motion
 * is skipped entirely when the visitor prefers reduced motion.
 */
class ScopeContributors extends HTMLElement {
	private motion = window.matchMedia('(prefers-reduced-motion: reduce)');
	private observer: IntersectionObserver | undefined;
	private events: AbortController | undefined;
	private inView = false;
	private loaded = false;
	private headingRevealed = false;
	private itemsRevealed = false;
	private expanded = false;
	private resize: ResizeObserver | undefined;
	private contributors: Contributor[] = [];

	connectedCallback() {
		this.events = new AbortController();
		this.toggleAttribute('data-animate', this.animates);
		this.motion.addEventListener('change', () => this.toggleAttribute('data-animate', this.animates), { signal: this.events.signal });
		this.observer = new IntersectionObserver((entries) => {
			if (!entries.some((entry) => entry.isIntersecting)) return;
			this.inView = true;
			this.observer?.disconnect();
			this.reveal();
		}, { rootMargin: '0px 0px -12% 0px' });
		this.observer.observe(this);
		this.trackPointer(this.events.signal);
		this.watchTips(this.events.signal);
		this.querySelector('[data-show-all]')?.addEventListener('click', () => this.showAll(), { signal: this.events.signal });
		void this.load();
	}

	disconnectedCallback() {
		this.observer?.disconnect();
		this.resize?.disconnect();
		this.events?.abort();
	}

	private get animates() {
		return !this.motion.matches && typeof Element.prototype.animate === 'function';
	}

	private get variant(): 'wall' | 'grid' {
		return this.dataset.variant === 'grid' ? 'grid' : 'wall';
	}

	private async load() {
		let result: ContributorsResult;
		let sample = false;
		try {
			result = await fetchContributors(this.dataset.src || CONTRIBUTORS_DATA_URL);
		} catch (error) {
			// Same dev fallback as the open calls; removed from production builds.
			if (import.meta.env.DEV) {
				console.info('[contributors] Live list unavailable; using the dev sample.', error);
				const { default: text } = await import('../data/contributors.sample.jsonl?raw');
				result = parseContributors(text);
				sample = true;
			} else {
				console.warn('[contributors] Could not load the live list.', error);
				this.setState('error');
				return;
			}
		}
		if (result.skipped.length) console.warn(`[contributors] Skipped invalid lines: ${result.skipped.join(', ')}`);
		this.querySelectorAll<HTMLElement>('[data-sample-tag]').forEach((tag) => { tag.hidden = !sample; });
		await this.render(result.contributors);
	}

	private async render(contributors: Contributor[]) {
		const list = this.querySelector<HTMLElement>('[data-list]');
		if (!list) throw new Error('Missing contributors list');
		this.contributors = sortForDisplay(contributors);
		const limit = Number(this.dataset.limit) || Infinity;
		const grid = this.variant === 'grid';
		const { shown, hidden } = grid
			? (this.expanded ? { shown: this.contributors, hidden: 0 } : firstPage(this.contributors, limit))
			: visible(this.contributors, limit);

		if (this.animates && this.inView) {
			await list.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-out' }).finished.catch(() => undefined);
		}
		const items = shown.map((contributor) => (grid ? this.card(contributor) : this.avatar(contributor)));
		if (hidden && !grid) items.push(this.more(hidden));
		list.replaceChildren(...items);
		this.placeTips();
		this.updateShowAll(grid ? hidden : 0);

		const people = this.contributors.length;
		const prs = totalPrs(this.contributors);
		this.querySelectorAll('[data-count-label]').forEach((label) => { label.textContent = contributorsLabel(people); });
		this.querySelectorAll('[data-prs]').forEach((element) => { element.textContent = prsLabel(prs); });
		this.querySelectorAll('[data-count-text]').forEach((text) => { text.textContent = `${people} ${contributorsLabel(people)}, ${prsLabel(prs)}`; });
		this.loaded = true;
		this.setState(people ? 'ready' : 'empty');
		this.reveal();
	}

	private updateShowAll(hidden: number) {
		const button = this.querySelector<HTMLButtonElement>('[data-show-all]');
		if (!button) return;
		button.hidden = !hidden;
		const label = button.querySelector('[data-show-all-label]');
		if (label) label.textContent = showAllLabel(this.contributors.length);
	}

	/** Appends the rest of the grid and moves focus to the first new card. */
	private showAll() {
		const list = this.querySelector<HTMLElement>('[data-list]');
		const button = this.querySelector<HTMLButtonElement>('[data-show-all]');
		if (!list || !button || this.expanded) return;
		this.expanded = true;
		const rest = this.contributors.slice(list.children.length).map((contributor) => this.card(contributor));
		list.append(...rest);
		button.hidden = true;
		this.enter(rest, 0, 40, 'rise');
		rest[0]?.querySelector('a')?.focus();
	}

	/**
	 * Keeps every tooltip, hidden or lifted on hover, inside the wall: a tip
	 * centered on an edge avatar would otherwise stick out and make the page
	 * scroll sideways on narrow screens. The arrow keeps pointing at the
	 * avatar. Transforms on the avatars never move their center, so this is
	 * safe to run mid-animation.
	 */
	private placeTips(links: Iterable<Element> = this.querySelectorAll('.thanks-avatar')) {
		if (this.variant !== 'wall') return;
		const bounds = this.getBoundingClientRect();
		if (!bounds.width) return;
		for (const link of links) {
			const tip = link.querySelector<HTMLElement>('.thanks-tip');
			if (!tip) continue;
			const rect = link.getBoundingClientRect();
			const center = rect.left + rect.width / 2;
			const shift = tipShift(center, tip.offsetWidth / 2, bounds.left, bounds.right, LIFT_SCALE);
			tip.style.setProperty('--tip-shift', `${Math.round(shift)}px`);
		}
	}

	private watchTips(signal: AbortSignal) {
		if (this.variant !== 'wall') return;
		this.resize = new ResizeObserver(() => this.placeTips());
		this.resize.observe(this);
		void document.fonts?.ready.then(() => { if (!signal.aborted) this.placeTips(); });
		const one = (event: Event) => {
			const link = event.target instanceof Element ? event.target.closest('.thanks-avatar') : null;
			if (link) this.placeTips([link]);
		};
		this.addEventListener('pointerover', one, { signal, passive: true });
		this.addEventListener('focusin', one, { signal });
	}

	private setState(state: State) {
		this.dataset.state = state;
		if (state !== 'loading') this.querySelector('[data-list]')?.removeAttribute('aria-busy');
	}

	private reveal() {
		if (!this.inView) return;
		if (!this.headingRevealed) {
			this.headingRevealed = true;
			this.enter([...this.querySelectorAll<HTMLElement>('[data-reveal]')], 0, 90, 'rise');
		}
		if (this.loaded && !this.itemsRevealed) {
			this.itemsRevealed = true;
			const items = [...this.querySelectorAll<HTMLElement>('[data-reveal-item]')];
			if (this.variant === 'wall') this.enter(items, 200, 45, 'pop');
			else this.enter(items, 180, 70, 'rise');
			if (this.contributors.length) this.countUp();
		}
	}

	private enter(elements: HTMLElement[], baseDelay: number, stagger: number, kind: 'rise' | 'pop') {
		elements.forEach((element, index) => {
			element.dataset.revealed = '';
			if (!this.animates) return;
			const from = kind === 'pop'
				? { opacity: 0, transform: `translateY(16px) scale(0.35) rotate(${index % 2 ? 14 : -14}deg)` }
				: { opacity: 0, transform: 'translateY(18px) scale(0.98)' };
			element.animate([from, { opacity: 1, transform: 'none' }], {
				duration: kind === 'pop' ? 720 : 650,
				delay: baseDelay + Math.min(index, MAX_STAGGER_STEPS) * stagger,
				easing: EASE_OUT_BACK,
				fill: 'backwards',
			});
		});
	}

	private countUp() {
		const pill = this.querySelector<HTMLElement>('[data-count-pill]');
		const counter = this.querySelector<HTMLElement>('[data-count]');
		if (!pill || !counter) return;
		const total = this.contributors.length;
		pill.dataset.shown = '';
		if (!this.animates) {
			counter.textContent = String(total);
			return;
		}
		pill.animate([{ opacity: 0, transform: 'scale(0.85)' }, { opacity: 1, transform: 'none' }], { duration: 500, easing: EASE_OUT_BACK, fill: 'backwards' });
		const start = performance.now();
		const tick = (now: number) => {
			const progress = Math.min((now - start) / COUNT_UP_MS, 1);
			counter.textContent = String(Math.round(total * (1 - (1 - progress) ** 3)));
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

	// Logins come from published data, so every value is set as text or attribute.
	private avatar(contributor: Contributor): HTMLLIElement {
		const item = this.item();
		const link = this.link(item, 'thanks-avatar', prsUrl(contributor.login));
		link.append(this.image(contributor, 56));
		const tip = this.span(link, 'thanks-tip');
		this.span(tip, 'thanks-tip__login', `@${contributor.login}`);
		this.span(tip, 'thanks-tip__prs', prsLabel(contributor.prs));
		this.span(link, 'sr-only', ' (opens in a new tab)');
		return item;
	}

	private card(contributor: Contributor): HTMLLIElement {
		const item = this.item();
		const link = this.link(item, 'contrib-card thanks-card', prsUrl(contributor.login));
		link.append(this.image(contributor, 96));
		const body = this.span(link, 'thanks-card__body');
		this.span(body, 'thanks-card__login', `@${contributor.login}`).title = `@${contributor.login}`;
		this.span(body, 'thanks-card__prs', prsLabel(contributor.prs));
		this.span(link, 'contrib-card__arrow thanks-card__arrow', '↗').setAttribute('aria-hidden', 'true');
		this.span(link, 'sr-only', ' (opens in a new tab)');
		return item;
	}

	private more(hidden: number): HTMLLIElement {
		const item = this.item();
		const link = document.createElement('a');
		link.className = 'thanks-more';
		link.href = this.dataset.moreHref || '#';
		this.span(link, '', `+${hidden}`).setAttribute('aria-hidden', 'true');
		this.span(link, 'sr-only', `${hidden} more ${contributorsLabel(hidden)}`);
		item.append(link);
		return item;
	}

	private item(): HTMLLIElement {
		const item = document.createElement('li');
		item.className = 'thanks-item';
		item.dataset.revealItem = '';
		return item;
	}

	private link(parent: HTMLElement, className: string, href: string): HTMLAnchorElement {
		const link = document.createElement('a');
		link.className = className;
		link.href = href;
		link.target = '_blank';
		link.rel = 'noopener noreferrer';
		parent.append(link);
		return link;
	}

	private image(contributor: Contributor, size: number): HTMLElement {
		const frame = document.createElement('span');
		frame.className = 'thanks-photo';
		frame.dataset.initial = contributor.login.charAt(0).toUpperCase();
		const image = document.createElement('img');
		image.src = avatarUrl(contributor.login, size * 2);
		image.width = size;
		image.height = size;
		image.alt = '';
		image.loading = 'lazy';
		image.decoding = 'async';
		// A deleted or renamed account has no avatar; show the initial instead.
		image.addEventListener('error', () => { frame.dataset.broken = ''; image.remove(); }, { once: true });
		frame.append(image);
		return frame;
	}

	private span(parent: Element, className: string, text?: string): HTMLElement {
		const element = document.createElement('span');
		if (className) element.className = className;
		if (text !== undefined) element.textContent = text;
		parent.append(element);
		return element;
	}
}

if (!customElements.get('scope-contributors')) customElements.define('scope-contributors', ScopeContributors);
