// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
	DATA_URL,
	chips,
	contributionLabels,
	countLabel,
	fetchIssues,
	issueUrl,
	pageCount,
	pageItems,
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
const ROTATE_MS = 7000;

/** Reasons the rotation is on hold. It advances only when there are none. */
type Hold = 'user' | 'hover' | 'focus' | 'offscreen' | 'hidden';

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
	private issues: ContributionIssue[] = [];
	private size = Infinity;
	private page = 0;
	private pages = 1;
	private switching = false;
	private holds = new Set<Hold>(['offscreen']);
	private timer: Animation | undefined;
	private visibility: IntersectionObserver | undefined;
	private dots: HTMLButtonElement[] = [];
	private toggle: HTMLButtonElement | undefined;

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
		// Card heights change with the viewport; drop the rotation's height lock.
		window.addEventListener('resize', () => {
			this.querySelector<HTMLElement>('[data-list]')?.style.removeProperty('min-height');
		}, { signal: this.events.signal, passive: true });
		void this.load();
	}

	disconnectedCallback() {
		this.observer?.disconnect();
		this.visibility?.disconnect();
		this.timer?.cancel();
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
		this.issues = sorted;
		this.size = limit;
		this.pages = Number.isFinite(limit) ? Math.max(pageCount(sorted.length, limit), 1) : 1;

		// Fade the skeleton out before swapping in real items, when on screen.
		if (this.animates && this.inView) {
			await list.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-out' }).finished.catch(() => undefined);
		}
		list.replaceChildren(...this.pageIssues(0).map((issue) => this.item(issue)));
		list.removeAttribute('aria-busy');
		this.querySelectorAll('[data-count-label]').forEach((label) => { label.textContent = countLabel(this.total); });
		this.querySelectorAll('[data-count-text]').forEach((text) => { text.textContent = `${this.total} ${countLabel(this.total)}`; });
		this.loaded = true;
		this.setState(this.total ? 'ready' : 'empty');
		if (this.hasAttribute('data-rotate') && this.pages > 1) this.setupRotation(list);
		this.reveal();
	}

	private pageIssues(page: number): ContributionIssue[] {
		return Number.isFinite(this.size) ? pageItems(this.issues, page, this.size) : this.issues;
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

	/**
	 * Cycles through pages of issues. Controls: one dot per page (the active
	 * one fills as a progress bar) and a pause button. The rotation holds
	 * while the list is hovered or focused, off screen, or the tab is hidden,
	 * and never autoplays under reduced motion.
	 */
	private setupRotation(list: HTMLElement) {
		const signal = this.events!.signal;
		const controls = document.createElement('div');
		controls.className = 'contrib-rotation';

		const dots = document.createElement('div');
		dots.className = 'contrib-dots';
		dots.setAttribute('role', 'group');
		dots.setAttribute('aria-label', 'Open call sets');
		this.dots = Array.from({ length: this.pages }, (_, page) => {
			const dot = document.createElement('button');
			dot.type = 'button';
			dot.className = 'contrib-dot';
			dot.setAttribute('aria-label', `Show set ${page + 1} of ${this.pages}`);
			const track = this.el(dot, 'span', 'contrib-dot__track');
			this.el(track, 'span', 'contrib-dot__fill');
			dot.addEventListener('click', () => void this.goTo(page), { signal });
			dots.append(dot);
			return dot;
		});

		const toggle = document.createElement('button');
		toggle.type = 'button';
		toggle.className = 'contrib-toggle';
		this.el(toggle, 'span', 'contrib-toggle__icon').setAttribute('aria-hidden', 'true');
		this.text(toggle, 'span', '', 'sr-only');
		toggle.addEventListener('click', () => {
			if (this.holds.has('user')) this.holds.delete('user');
			else this.holds.add('user');
			this.sync();
		}, { signal });
		this.toggle = toggle;

		controls.append(dots, toggle);
		list.after(controls);

		const hold = (reason: Hold, on: boolean) => {
			if (on) this.holds.add(reason);
			else this.holds.delete(reason);
			this.sync();
		};
		list.addEventListener('pointerenter', () => hold('hover', true), { signal });
		list.addEventListener('pointerleave', () => hold('hover', false), { signal });
		list.addEventListener('focusin', () => hold('focus', true), { signal });
		list.addEventListener('focusout', (event) => {
			if (!list.contains(event.relatedTarget as Node | null)) hold('focus', false);
		}, { signal });
		document.addEventListener('visibilitychange', () => hold('hidden', document.hidden), { signal });
		this.motion.addEventListener('change', () => {
			this.toggleAttribute('data-animate', this.animates);
			this.restartTimer();
		}, { signal });
		this.visibility = new IntersectionObserver((entries) => {
			hold('offscreen', !entries.some((entry) => entry.isIntersecting));
		}, { threshold: 0.25 });
		this.visibility.observe(list);

		this.holds.add('offscreen');
		if (document.hidden) this.holds.add('hidden');
		this.updateDots();
		this.restartTimer();
	}

	/** Restarts the progress fill on the active dot; its end advances the page. */
	private restartTimer() {
		this.timer?.cancel();
		this.timer = undefined;
		const autoplay = this.animates;
		if (this.toggle) this.toggle.hidden = !autoplay;
		const fill = this.dots[this.page]?.querySelector<HTMLElement>('.contrib-dot__fill');
		if (autoplay && fill) {
			this.timer = fill.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: ROTATE_MS, easing: 'linear' });
			this.timer.onfinish = () => void this.goTo((this.page + 1) % this.pages);
		}
		this.sync();
	}

	/** Plays or pauses the timer from the current holds. */
	private sync() {
		const paused = this.holds.size > 0;
		if (this.timer) {
			if (paused) this.timer.pause();
			else this.timer.play();
		}
		if (this.toggle) {
			const userPaused = this.holds.has('user');
			this.toggle.dataset.paused = String(userPaused);
			this.toggle.lastElementChild!.textContent = userPaused ? 'Resume rotating open calls' : 'Pause rotating open calls';
		}
	}

	private updateDots() {
		this.dots.forEach((dot, page) => {
			if (page === this.page) dot.setAttribute('aria-current', 'true');
			else dot.removeAttribute('aria-current');
		});
	}

	private async goTo(page: number) {
		const list = this.querySelector<HTMLElement>('[data-list]');
		if (!list || this.switching || page === this.page) return;
		this.switching = true;
		this.timer?.cancel();
		this.page = page;
		this.updateDots();

		const outgoing = [...list.children] as HTMLElement[];
		if (this.animates) {
			await Promise.all(outgoing.map((element, index) => element.animate(
				[{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-12px) scale(0.98)' }],
				{ duration: 240, delay: index * 45, easing: EASE_OUT, fill: 'forwards' },
			).finished.catch(() => undefined)));
		}
		// Keep the grid from collapsing while card heights change between sets.
		list.style.minHeight = `${Math.max(parseFloat(list.style.minHeight) || 0, list.offsetHeight)}px`;
		const incoming = this.pageIssues(page).map((issue) => this.item(issue));
		list.replaceChildren(...incoming);
		this.enter(incoming, 0, STAGGER_MS);
		this.switching = false;
		this.restartTimer();
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
